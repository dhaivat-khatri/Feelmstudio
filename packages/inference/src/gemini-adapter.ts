import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GoogleGenAI } from '@google/genai';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_LOCATION = 'us-central1';
const IMAGE_TIMEOUT_MS = 60_000;

/**
 * The slice of the `@google/genai` client the two adapters below actually call.
 * Declaring it explicitly (rather than importing the SDK's sprawling parameter
 * types) is what lets a test inject a hand-rolled fake — no network, no module
 * mock. `resolveClient` casts a real `GoogleGenAI` to this on the way out.
 */
export interface GeminiClient {
  readonly models: {
    generateContent(params: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }): Promise<{
      text?: string;
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
      }>;
    }>;
  };
}

export interface GeminiClientOptions {
  /**
   * Vertex AI mode (recommended). Uses Application Default Credentials —
   * `gcloud auth application-default login` locally, the attached service
   * account on Cloud Run. Inferred from `GOOGLE_GENAI_USE_VERTEXAI=true` or the
   * presence of `GOOGLE_CLOUD_PROJECT` when not passed.
   */
  readonly vertexai?: boolean;
  /** GCP project id for Vertex mode. Falls back to `GOOGLE_CLOUD_PROJECT`. */
  readonly project?: string;
  /** Vertex region. Falls back to `GOOGLE_CLOUD_LOCATION`, then `us-central1`. */
  readonly location?: string;
  /** AI Studio mode: an API key instead of Vertex/ADC. Falls back to `GEMINI_API_KEY`. */
  readonly apiKey?: string;
  /** Test seam — inject a fake client and skip real credential resolution entirely. */
  readonly client?: GeminiClient;
}

/**
 * Picks Vertex AI (ADC) or AI Studio (API key) from the options + environment,
 * and fails loudly with a non-retryable error when neither is configured — the
 * same "you forgot to set this up" signal the old raw-fetch adapter gave.
 */
function resolveClient(options: GeminiClientOptions): GeminiClient {
  if (options.client) return options.client;

  const project = options.project ?? process.env.GOOGLE_CLOUD_PROJECT;
  const useVertex = options.vertexai ?? (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || project !== undefined);
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;

  if (useVertex) {
    if (!project) {
      throw new InferenceError({
        code: 'GEMINI_VERTEX_PROJECT_MISSING',
        message: 'Vertex AI mode needs a project: set GOOGLE_CLOUD_PROJECT (or pass { project }).',
        retryable: false,
      });
    }
    const location = options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_LOCATION;
    return new GoogleGenAI({ vertexai: true, project, location }) as unknown as GeminiClient;
  }

  if (!apiKey) {
    throw new InferenceError({
      code: 'GEMINI_API_KEY_MISSING',
      message: 'No Gemini credentials: set GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY (AI Studio).',
      retryable: false,
    });
  }
  return new GoogleGenAI({ apiKey }) as unknown as GeminiClient;
}

/**
 * Maps an `@google/genai` failure onto an `InferenceError`. The SDK throws
 * `ApiError` (extends Error) with a numeric `status` for HTTP-level failures;
 * anything without a numeric status is treated as a transport problem and
 * retried. 429 and 5xx are retryable, other 4xx (bad/blocked request, auth) are not.
 */
function toInferenceError(err: unknown, failedCode: string, unreachableCode: string): InferenceError {
  if (err instanceof InferenceError) return err;
  const status = (err as { status?: unknown }).status;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number') {
    return new InferenceError({ code: failedCode, message, retryable: status === 429 || status >= 500 });
  }
  return new InferenceError({ code: unreachableCode, message, retryable: true, cause: err });
}

/**
 * Rejects a promise if it hasn't settled within `ms`. The underlying SDK call
 * keeps running but we stop waiting — a hung image/audio generation becomes a
 * clean retryable error rather than a stuck job.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new InferenceError({ code, message: `Timed out after ${ms}ms`, retryable: true })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface GeminiTextAdapterOptions extends GeminiClientOptions {
  readonly model?: string;
}

/**
 * Real text generation via Gemini (Vertex AI or AI Studio). Same JSON-object
 * contract as local-text-adapter.ts — callers instruct the model via
 * `request.prompt` / `request.params.systemPrompt` to return exactly one JSON
 * object — enforced here with `responseMimeType: 'application/json'` rather than
 * the local adapter's brittle first-`{`/last-`}` scan.
 */
export function createGeminiTextAdapter(options: GeminiTextAdapterOptions = {}): InferenceAdapter {
  const model = options.model ?? process.env.GEMINI_TEXT_MODEL ?? DEFAULT_TEXT_MODEL;

  return {
    capability: 'text',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const client = resolveClient(options);
      const systemPrompt = request.params?.systemPrompt;

      let text: string | undefined;
      try {
        const response = await client.models.generateContent({
          model,
          contents: request.prompt,
          config: {
            responseMimeType: 'application/json',
            ...(typeof systemPrompt === 'string' && { systemInstruction: systemPrompt }),
            ...(request.seed !== undefined && { seed: request.seed }),
          },
        });
        text = response.text;
      } catch (err) {
        throw toInferenceError(err, 'GEMINI_GENERATION_FAILED', 'GEMINI_UNREACHABLE');
      }

      if (typeof text !== 'string' || text.length === 0) {
        throw new InferenceError({
          code: 'GEMINI_NO_TEXT',
          message: 'Gemini response had no text part.',
          retryable: true,
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        throw new InferenceError({
          code: 'GEMINI_NOT_JSON',
          message: `Could not parse Gemini output as JSON: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        });
      }

      return { payload, model, ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}

export interface ImagenAdapterOptions extends GeminiClientOptions {
  readonly model?: string;
  /** Directory generated images are written to. */
  readonly mediaDir: string;
  readonly aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
}

export interface GeminiImagePayload {
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
}

const ASPECT_RATIO_DIMENSIONS: Record<NonNullable<ImagenAdapterOptions['aspectRatio']>, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '3:4': { width: 896, height: 1152 },
  '4:3': { width: 1152, height: 896 },
  '9:16': { width: 768, height: 1344 },
  '16:9': { width: 1344, height: 768 },
};

/**
 * Real image generation via a Gemini image model (`gemini-2.5-flash-image`) on
 * Vertex AI, through `generateContent` with an IMAGE response modality — the
 * Imagen `:predict` / `generateImages` path is deprecated and, for some projects,
 * not provisioned. Same output shape (`{filePath, width, height}` under
 * `mediaDir`) as local-image-adapter.ts's `ImagePayload`, so routes.ts's
 * `/media/:filename` serving doesn't care which adapter produced the file.
 * `width`/`height` are the nominal target for the requested aspect ratio — the
 * model isn't pixel-exact, but the scene UI only needs a ratio to lay out with.
 */
export function createImagenAdapter(options: ImagenAdapterOptions): InferenceAdapter {
  const model = options.model ?? process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
  const aspectRatio = options.aspectRatio ?? '1:1';
  const { width, height } = ASPECT_RATIO_DIMENSIONS[aspectRatio];

  return {
    capability: 'image',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const client = resolveClient(options);
      const prompt = aspectRatio === '1:1' ? request.prompt : `${request.prompt}\n\n(${aspectRatio} aspect ratio)`;

      let base64: string | undefined;
      try {
        const response = await withTimeout(
          client.models.generateContent({
            model,
            contents: prompt,
            config: {
              responseModalities: ['IMAGE'],
              ...(request.seed !== undefined && { seed: request.seed }),
            },
          }),
          IMAGE_TIMEOUT_MS,
          'IMAGEN_UNREACHABLE',
        );
        for (const part of response.candidates?.[0]?.content?.parts ?? []) {
          if (part.inlineData?.data) {
            base64 = part.inlineData.data;
            break;
          }
        }
      } catch (err) {
        throw toInferenceError(err, 'IMAGEN_GENERATION_FAILED', 'IMAGEN_UNREACHABLE');
      }

      if (!base64) {
        throw new InferenceError({
          code: 'IMAGEN_NO_IMAGE',
          message: 'Gemini image response had no inline image data.',
          retryable: true,
        });
      }

      await mkdir(options.mediaDir, { recursive: true });
      const outPath = join(options.mediaDir, `${crypto.randomUUID()}.png`);
      await writeFile(outPath, Buffer.from(base64, 'base64'));

      const payload: GeminiImagePayload = { filePath: outPath, width, height };
      return { payload, model, ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}
