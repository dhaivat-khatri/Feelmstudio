import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

const run = promisify(execFile);

export interface KenBurnsVideoAdapterOptions {
  /** Directory generated videos are written to. */
  readonly mediaDir: string;
  /** Path to the ffmpeg executable. Defaults to 'ffmpeg' on PATH. */
  readonly ffmpegBin?: string;
  readonly durationSeconds?: number;
  readonly fps?: number;
  /** Should match the source image's dimensions to avoid letterboxing/stretching. */
  readonly width?: number;
  readonly height?: number;
}

export interface VideoPayload {
  readonly filePath: string;
  readonly durationSeconds: number;
  readonly motion: Motion;
}

type Motion = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown';

/**
 * Ken Burns has no video model to read a prompt with — the only thing a prompt can
 * steer is which of a handful of fixed camera moves ffmpeg plays. First keyword match
 * wins; no match falls back to a slow zoom-in (the original, only, behaviour before
 * this existed).
 */
function detectMotion(prompt: string): Motion {
  const p = prompt.toLowerCase();
  if (/\bzoom\s*out\b/.test(p)) return 'zoomOut';
  if (/\bpan\s*left\b/.test(p)) return 'panLeft';
  if (/\bpan\s*right\b/.test(p)) return 'panRight';
  if (/\b(pan|tilt)\s*up\b/.test(p)) return 'panUp';
  if (/\b(pan|tilt)\s*down\b/.test(p)) return 'panDown';
  return 'zoomIn';
}

// zoompan snaps its crop origin to whole pixels every frame — on a
// near-native-resolution image that rounding is a visible jitter/shake. Rendering
// the pan against a heavily upscaled copy makes each step a sub-pixel fraction of
// the frame, so the motion reads as smooth. 4x is enough; more just costs time.
const SUPERSAMPLE = 4;
// End-of-move zoom. Bigger than the old 1.15 so the move is actually felt, not
// lost under the jitter it used to produce.
const ZOOM_MAX = 1.4;
const PAN_ZOOM = 1.18;
const CENTER_X = "x='iw/2-(iw/zoom/2)'";
const CENTER_Y = "y='ih/2-(ih/zoom/2)'";

/**
 * A zoompan expression that eases `motion` across the whole clip (progress
 * `on/${frames}` runs 0→1). Paired with the SUPERSAMPLE upscale below.
 */
function zoompanFilter(motion: Motion, frames: number, width: number, height: number, fps: number): string {
  const p = `(on/${frames})`; // linear progress 0..1 over the clip
  const tail = `d=${frames}:s=${width}x${height}:fps=${fps}`;
  const zIn = `z='1+${(ZOOM_MAX - 1).toFixed(3)}*${p}'`;
  const zOut = `z='${ZOOM_MAX}-${(ZOOM_MAX - 1).toFixed(3)}*${p}'`;
  switch (motion) {
    case 'zoomOut':
      return `zoompan=${zOut}:${CENTER_X}:${CENTER_Y}:${tail}`;
    case 'panLeft':
      return `zoompan=z=${PAN_ZOOM}:x='(iw-iw/zoom)*(1-${p})':${CENTER_Y}:${tail}`;
    case 'panRight':
      return `zoompan=z=${PAN_ZOOM}:x='(iw-iw/zoom)*${p}':${CENTER_Y}:${tail}`;
    case 'panUp':
      return `zoompan=z=${PAN_ZOOM}:${CENTER_X}:y='(ih-ih/zoom)*(1-${p})':${tail}`;
    case 'panDown':
      return `zoompan=z=${PAN_ZOOM}:${CENTER_X}:y='(ih-ih/zoom)*${p}':${tail}`;
    case 'zoomIn':
    default:
      return `zoompan=${zIn}:${CENTER_X}:${CENTER_Y}:${tail}`;
  }
}

/**
 * Zero-cost "video" from a still: ffmpeg's zoompan filter turns the scene's already-
 * generated image into one of a few fixed camera moves — zoom in/out, pan in a
 * direction — picked from keywords in the prompt (see `detectMotion`). No model, no
 * per-generation compute beyond what already produced the image. This is what stands
 * in for real text-to-video until the hardware (or willingness to pay for cloud GPU
 * time) exists for one; see packages/inference/README.md.
 */
export function createKenBurnsVideoAdapter(options: KenBurnsVideoAdapterOptions): InferenceAdapter {
  const ffmpegBin = options.ffmpegBin ?? 'ffmpeg';
  const durationSeconds = options.durationSeconds ?? 5;
  const fps = options.fps ?? 30;
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;

  return {
    capability: 'video',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const imagePath = request.params?.imagePath;
      if (typeof imagePath !== 'string' || !imagePath) {
        throw new InferenceError({
          code: 'MISSING_IMAGE',
          message: 'Ken Burns video generation requires params.imagePath — generate the scene image first',
          retryable: false,
        });
      }

      await mkdir(options.mediaDir, { recursive: true });
      const outPath = join(options.mediaDir, `${crypto.randomUUID()}.mp4`);
      const frames = durationSeconds * fps;
      const motion = detectMotion(request.prompt);
      const zoompan = zoompanFilter(motion, frames, width, height, fps);
      // Upscale first (kills zoompan's per-frame pixel-snap jitter), run the move,
      // then a light unsharp so the downscaled result stays crisp. Even fps output,
      // faststart so it plays immediately in a <video> tag.
      const vf = [
        `scale=iw*${SUPERSAMPLE}:ih*${SUPERSAMPLE}:flags=bicubic`,
        zoompan,
        'unsharp=5:5:0.4',
        'format=yuv420p',
      ].join(',');

      try {
        await run(
          ffmpegBin,
          [
            '-y', '-loop', '1', '-i', imagePath,
            '-vf', vf,
            '-t', String(durationSeconds),
            '-r', String(fps),
            '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart',
            outPath,
          ],
          { maxBuffer: 64 * 1024 * 1024 },
        );
      } catch (err) {
        throw new InferenceError({
          code: 'VIDEO_GENERATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        });
      }

      const payload: VideoPayload = { filePath: outPath, durationSeconds, motion };
      return { payload, model: 'kenburns-ffmpeg', ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}
