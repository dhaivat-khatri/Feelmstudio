import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GoogleAuth } from 'google-auth-library';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

const DEFAULT_MODEL = 'lyria-002';
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_TIMEOUT_MS = 90_000;

/** Lyria 2 returns a ~30s instrumental clip. Reported on the payload for the timeline. */
const LYRIA_CLIP_SECONDS = 30;

export interface LyriaMusicPayload {
  readonly filePath: string;
  readonly mimeType: string;
  readonly durationSeconds: number;
}

export interface LyriaMusicAdapterOptions {
  /** Directory the WAV is written to. */
  readonly mediaDir: string;
  /** GCP project. Falls back to `GOOGLE_CLOUD_PROJECT`. */
  readonly project?: string;
  /** Vertex region. Falls back to `GOOGLE_CLOUD_LOCATION`, then `us-central1`. */
  readonly location?: string;
  /** Model id. Default `lyria-002`. */
  readonly model?: string;
  /** Hard deadline for the predict call. Default 90s. */
  readonly timeoutMs?: number;
  /** Test seam — inject a fake `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam — supply the bearer token directly instead of resolving ADC. */
  readonly getAccessToken?: () => Promise<string>;
}

interface LyriaPrediction {
  readonly audioContent?: string;
  readonly bytesBase64Encoded?: string;
  readonly mimeType?: string;
}

/**
 * Real music generation via Lyria 2 on Vertex AI (`:predict`). Same output shape
 * as the image adapters (`{ filePath, ... }` under `mediaDir` or a bucket) so
 * routes.ts's `/media/:filename` serving doesn't care which adapter produced it.
 * Auth is Application Default Credentials (attached service account on Cloud Run).
 */
export function createLyriaMusicAdapter(options: LyriaMusicAdapterOptions): InferenceAdapter {
  const model = options.model ?? process.env.GEMINI_MUSIC_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const auth = options.getAccessToken ? { getAccessToken: options.getAccessToken } : lazyAdcToken();

  return {
    capability: 'music',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const project = options.project ?? process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) {
        throw new InferenceError({
          code: 'LYRIA_PROJECT_MISSING',
          message: 'Lyria needs a GCP project: set GOOGLE_CLOUD_PROJECT (or pass { project }).',
          retryable: false,
        });
      }
      const location = options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_LOCATION;
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;

      // seed and sample_count are mutually exclusive in the Lyria API.
      const instance =
        request.seed !== undefined ? { prompt: request.prompt, seed: request.seed } : { prompt: request.prompt };
      const requestBody = {
        instances: [instance],
        parameters: request.seed !== undefined ? {} : { sample_count: 1 },
      };

      let token: string;
      try {
        token = await auth.getAccessToken();
      } catch (err) {
        throw new InferenceError({
          code: 'LYRIA_AUTH_FAILED',
          message: `Could not obtain a Google access token: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          cause: err,
        });
      }

      let response: Response;
      try {
        response = await withDeadline(
          doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(requestBody),
          }),
          timeoutMs,
        );
      } catch (err) {
        if (err instanceof InferenceError) throw err;
        throw new InferenceError({
          code: 'LYRIA_UNREACHABLE',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        });
      }

      if (!response.ok) {
        throw new InferenceError({
          code: 'LYRIA_GENERATION_FAILED',
          message: `Lyria returned ${response.status}: ${await safeText(response)}`,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      let body: { predictions?: LyriaPrediction[] };
      try {
        body = (await response.json()) as { predictions?: LyriaPrediction[] };
      } catch (err) {
        throw new InferenceError({
          code: 'LYRIA_UNREACHABLE',
          message: `Lyria response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        });
      }

      const prediction = body.predictions?.[0];
      const base64 = prediction?.audioContent ?? prediction?.bytesBase64Encoded;
      if (!base64) {
        throw new InferenceError({ code: 'LYRIA_NO_AUDIO', message: 'Lyria response had no audio bytes.', retryable: true });
      }

      const mimeType = prediction?.mimeType ?? 'audio/wav';
      const bytes = Buffer.from(base64, 'base64');

      await mkdir(options.mediaDir, { recursive: true });
      const filePath = join(options.mediaDir, `${crypto.randomUUID()}.wav`);
      await writeFile(filePath, bytes);

      const payload: LyriaMusicPayload = { filePath, mimeType, durationSeconds: LYRIA_CLIP_SECONDS };
      return { payload, model, ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}

/** Lazily builds a `GoogleAuth` client so importing this module never touches credentials. */
function lazyAdcToken(): { getAccessToken: () => Promise<string> } {
  let client: GoogleAuth | undefined;
  return {
    async getAccessToken() {
      client ??= new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
      const token = await client.getAccessToken();
      if (!token) throw new Error('GoogleAuth returned an empty access token');
      return token;
    },
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new InferenceError({ code: 'LYRIA_UNREACHABLE', message: `Timed out after ${ms}ms`, retryable: true })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
