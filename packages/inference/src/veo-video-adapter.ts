import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { GoogleAuth } from 'google-auth-library';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

const DEFAULT_MODEL = 'veo-3.1-fast-generate-001';
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 6 * 60_000;
const DEFAULT_DURATION_SECONDS = 8;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export interface VeoVideoPayload {
  readonly filePath: string;
  readonly durationSeconds: number;
  /** Marks how the clip was produced, for the timeline/decision log. */
  readonly source: 'veo';
}

export interface VeoVideoAdapterOptions {
  readonly mediaDir: string;
  /** GCP project. Falls back to `GOOGLE_CLOUD_PROJECT`. */
  readonly project?: string;
  /** Vertex region. Falls back to `GOOGLE_CLOUD_LOCATION`, then `us-central1`. */
  readonly location?: string;
  /** Model id. Default `veo-3.0-fast-generate-001`. */
  readonly model?: string;
  /** Clip length, 5–8s. Default 8. */
  readonly durationSeconds?: number;
  /** `16:9` (default) or `9:16`. */
  readonly aspectRatio?: '16:9' | '9:16';
  /** Poll spacing while the operation runs. Default 10s. */
  readonly pollIntervalMs?: number;
  /** Hard ceiling on the whole generate. Default 6 min. */
  readonly timeoutMs?: number;
  /** Test seam — inject a fake `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam — supply the bearer token directly instead of resolving ADC. */
  readonly getAccessToken?: () => Promise<string>;
}

interface VeoOperation {
  readonly name?: string;
  readonly done?: boolean;
  readonly error?: { message?: string };
  readonly response?: {
    readonly videos?: Array<{ bytesBase64Encoded?: string; gcsUri?: string; video?: { bytesBase64Encoded?: string } }>;
  };
}

/**
 * Real image-to-video via Veo 3 Fast on Vertex AI. Takes the scene's already-
 * generated still as the first frame and a text prompt for the motion, then runs
 * Veo's long-running operation (`:predictLongRunning` → poll `:fetchPredictOperation`)
 * to a real ~8s clip. Same `{ filePath, durationSeconds }` payload shape as the
 * Ken Burns adapter, so routes/UI don't care which produced the mp4.
 *
 * Paid and slow (1–3 min/clip) — only wire this in behind an explicit opt-in
 * (`OSAI_VIDEO=veo`), never as the default.
 */
export function createVeoVideoAdapter(options: VeoVideoAdapterOptions): InferenceAdapter {
  const model = options.model ?? process.env.OSAI_VEO_MODEL ?? DEFAULT_MODEL;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const durationSeconds = options.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const aspectRatio = options.aspectRatio ?? '16:9';
  const doFetch = options.fetchImpl ?? fetch;
  const auth = options.getAccessToken ? { getAccessToken: options.getAccessToken } : lazyAdcToken();

  return {
    capability: 'video',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const imagePath = request.params?.imagePath;
      if (typeof imagePath !== 'string' || !imagePath) {
        throw new InferenceError({
          code: 'MISSING_IMAGE',
          message: 'Veo image-to-video needs params.imagePath — generate the scene image first',
          retryable: false,
        });
      }

      const project = options.project ?? process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) {
        throw new InferenceError({
          code: 'VEO_PROJECT_MISSING',
          message: 'Veo needs a GCP project: set GOOGLE_CLOUD_PROJECT (or pass { project }).',
          retryable: false,
        });
      }
      const location = options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_LOCATION;
      const modelBase = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}`;

      const imageBytes = await readFile(imagePath);
      const mimeType = MIME_BY_EXT[extname(imagePath).toLowerCase()] ?? 'image/png';

      let token: string;
      try {
        token = await auth.getAccessToken();
      } catch (err) {
        throw new InferenceError({
          code: 'VEO_AUTH_FAILED',
          message: `Could not obtain a Google access token: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          cause: err,
        });
      }
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

      // 1. start the operation
      const startBody = {
        instances: [
          {
            prompt: request.prompt,
            image: { bytesBase64Encoded: imageBytes.toString('base64'), mimeType },
          },
        ],
        parameters: {
          aspectRatio,
          sampleCount: 1,
          durationSeconds,
          ...(request.seed !== undefined && { seed: request.seed }),
        },
      };

      const started = await postJson<VeoOperation>(
        doFetch,
        `${modelBase}:predictLongRunning`,
        headers,
        startBody,
        'VEO_GENERATION_FAILED',
      );
      const operationName = started.name;
      if (!operationName) {
        throw new InferenceError({
          code: 'VEO_GENERATION_FAILED',
          message: 'Veo start returned no operation name',
          retryable: true,
        });
      }

      // 2. poll until done or the deadline
      const deadline = Date.now() + timeoutMs;
      let op: VeoOperation = started;
      while (!op.done) {
        if (Date.now() >= deadline) {
          throw new InferenceError({
            code: 'VEO_TIMEOUT',
            message: `Veo operation did not finish within ${timeoutMs}ms`,
            retryable: true,
          });
        }
        await sleep(pollIntervalMs);
        op = await postJson<VeoOperation>(
          doFetch,
          `${modelBase}:fetchPredictOperation`,
          headers,
          { operationName },
          'VEO_GENERATION_FAILED',
        );
      }

      if (op.error) {
        throw new InferenceError({
          code: 'VEO_GENERATION_FAILED',
          message: op.error.message ?? 'Veo operation failed',
          retryable: false,
        });
      }

      const first = op.response?.videos?.[0];
      const base64 = first?.bytesBase64Encoded ?? first?.video?.bytesBase64Encoded;
      if (!base64) {
        throw new InferenceError({
          code: 'VEO_NO_VIDEO',
          message: first?.gcsUri
            ? `Veo wrote to ${first.gcsUri} but this adapter only reads inline bytes (no storageUri set)`
            : 'Veo response had no video bytes',
          retryable: true,
        });
      }

      await mkdir(options.mediaDir, { recursive: true });
      const outPath = join(options.mediaDir, `${crypto.randomUUID()}.mp4`);
      await writeFile(outPath, Buffer.from(base64, 'base64'));

      const payload: VeoVideoPayload = { filePath: outPath, durationSeconds, source: 'veo' };
      return { payload, model, ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}

async function postJson<T>(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  failCode: string,
): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new InferenceError({
      code: 'VEO_UNREACHABLE',
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
      cause: err,
    });
  }
  if (!response.ok) {
    throw new InferenceError({
      code: failCode,
      message: `Veo returned ${response.status}: ${await safeText(response)}`,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new InferenceError({
      code: 'VEO_UNREACHABLE',
      message: `Veo response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
      cause: err,
    });
  }
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
