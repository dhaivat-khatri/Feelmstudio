import { execFile, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

const run = promisify(execFile);

/** The venv this package installs mflux into — also has torch/PIL/numpy, reused here. */
const DEFAULT_PYTHON_BIN = fileURLToPath(new URL('../.venv/bin/python3', import.meta.url));
const DEFAULT_SEEDANCE_SERVER_SCRIPT = fileURLToPath(new URL('../python/seedance_server.py', import.meta.url));
const DEFAULT_PORT = 8766;

export interface SeedanceAdapterOptions {
  /** Directory generated media is written to. */
  readonly mediaDir: string;
  /** Port the persistent Seedance server (see startSeedanceServer) is listening on. */
  readonly port?: number;
  readonly model?: string;
  readonly steps?: number;
  /** Video only: frames per second used when stitching sampled frames into an mp4. */
  readonly fps?: number;
  /** Video only: path to the ffmpeg executable. Defaults to 'ffmpeg' on PATH. */
  readonly ffmpegBin?: string;
}

export interface SeedanceImagePayload {
  readonly filePath: string;
}

export interface SeedanceVideoPayload {
  readonly filePath: string;
  readonly durationSeconds: number;
}

interface GenerateResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly framePaths?: readonly string[];
}

async function callGenerate(port: number, body: Record<string, unknown>): Promise<GenerateResponse> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new InferenceError({
      code: 'SEEDANCE_SERVER_UNREACHABLE',
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
      cause: err,
    });
  }

  const parsed = (await res.json().catch(() => ({}))) as GenerateResponse;
  if (!res.ok || parsed.ok === false) {
    throw new InferenceError({
      code: 'SEEDANCE_GENERATION_FAILED',
      message: parsed.error ?? res.statusText,
      retryable: true,
    });
  }
  return parsed;
}

function referenceImagePath(request: InferenceRequest): string | undefined {
  const value = request.params?.referenceImagePath;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Experimental image adapter for the Seedance-style DiT built from the
 * Seedance research (research/seedance-model/). **Untrained by default** —
 * produces structured noise, not real images, until the server behind this
 * adapter is started with a --checkpoint from a model trained via
 * research/seedance-model/train.py. See that package's README and
 * packages/inference/README.md before using this for anything but exercising
 * the pipeline end to end.
 *
 * Pass a reference image via `request.params.referenceImagePath` to exercise
 * Seedance's "Reference-to-Video" style subject conditioning (research §5.6).
 */
export function createSeedanceImageAdapter(options: SeedanceAdapterOptions): InferenceAdapter {
  const port = options.port ?? DEFAULT_PORT;
  const steps = options.steps ?? 20;

  return {
    capability: 'image',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      await mkdir(options.mediaDir, { recursive: true });
      const outPath = join(options.mediaDir, `${crypto.randomUUID()}.png`);
      const refPath = referenceImagePath(request);

      await callGenerate(port, {
        prompt: request.prompt,
        modality: 'image',
        steps,
        output: outPath,
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(refPath && { referenceImagePath: refPath }),
      });

      const payload: SeedanceImagePayload = { filePath: outPath };
      return {
        payload,
        model: options.model ?? 'seedance-style-dit-untrained',
        ...(request.seed !== undefined && { seed: request.seed }),
      };
    },
  };
}

/**
 * Experimental video adapter, same model and same "untrained by default"
 * caveat as createSeedanceImageAdapter. The Python server samples raw frames
 * (it has no video-encoding step of its own); this adapter stitches them into
 * an mp4 with ffmpeg and deletes the intermediate frame files, so the payload
 * shape matches the rest of this package's video adapters (a single playable
 * file, not a frame array).
 */
export function createSeedanceVideoAdapter(options: SeedanceAdapterOptions): InferenceAdapter {
  const port = options.port ?? DEFAULT_PORT;
  const steps = options.steps ?? 20;
  const fps = options.fps ?? 8;
  const ffmpegBin = options.ffmpegBin ?? 'ffmpeg';

  return {
    capability: 'video',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      await mkdir(options.mediaDir, { recursive: true });
      const stem = join(options.mediaDir, crypto.randomUUID());
      const outPath = `${stem}.mp4`;
      const refPath = referenceImagePath(request);

      const result = await callGenerate(port, {
        prompt: request.prompt,
        modality: 'video',
        steps,
        output: outPath,
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(refPath && { referenceImagePath: refPath }),
      });

      const framePaths = result.framePaths ?? [];
      try {
        await run(ffmpegBin, [
          '-y', '-framerate', String(fps),
          '-i', `${stem}_frame%03d.png`,
          '-pix_fmt', 'yuv420p', outPath,
        ]);
      } catch (err) {
        throw new InferenceError({
          code: 'SEEDANCE_VIDEO_STITCH_FAILED',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        });
      } finally {
        await Promise.all(framePaths.map((p) => rm(p, { force: true }).catch(() => undefined)));
      }

      const payload: SeedanceVideoPayload = { filePath: outPath, durationSeconds: framePaths.length / fps };
      return {
        payload,
        model: options.model ?? 'seedance-style-dit-untrained',
        ...(request.seed !== undefined && { seed: request.seed }),
      };
    },
  };
}

export interface SeedanceServerHandle {
  readonly url: string;
  stop(): void;
}

export interface StartSeedanceServerOptions {
  readonly port?: number;
  /** Path to a checkpoint saved by research/seedance-model/train.py. Omit to run untrained. */
  readonly checkpoint?: string;
  readonly pythonBin?: string;
  readonly scriptPath?: string;
  readonly readyTimeoutMs?: number;
}

/**
 * Spawns the persistent Seedance server (packages/inference/python/seedance_server.py),
 * streams its logs through, and resolves once it responds to /health. Same warm-process
 * pattern as startImageServer — call stop() on shutdown to avoid leaking the process.
 */
export async function startSeedanceServer(options: StartSeedanceServerOptions = {}): Promise<SeedanceServerHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
  const scriptPath = options.scriptPath ?? DEFAULT_SEEDANCE_SERVER_SCRIPT;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;

  const args = [scriptPath, '--port', String(port)];
  if (options.checkpoint) args.push('--checkpoint', options.checkpoint);

  const child = spawn(pythonBin, args, { stdio: ['ignore', 'inherit', 'inherit'] });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`seedance_server.py exited early (code ${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // Not listening yet — expected while the model loads. Keep polling.
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  child.kill();
  throw new Error(`seedance_server.py did not become ready within ${readyTimeoutMs}ms`);
}
