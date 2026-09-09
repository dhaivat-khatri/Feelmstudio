import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createGeminiTextAdapter, createImagenAdapter, type GeminiClient } from '../src/gemini-adapter.js';

/**
 * Real Gemini/Imagen calls are manually smoke-tested against the live API
 * (see packages/inference/README.md) — not run in this suite, no network or
 * Google credentials assumed. Each test injects a fake `GeminiClient` via the
 * adapters' `client` option to check request shape, response parsing, and the
 * SDK-error → InferenceError mapping.
 */

/** A thrown value shaped like `@google/genai`'s ApiError: an Error with a numeric `status`. */
const apiError = (status: number): Error => Object.assign(new Error(`api error ${status}`), { status });

afterEach(() => vi.unstubAllEnvs());

describe('createGeminiTextAdapter', () => {
  it('sends prompt/systemInstruction/seed and parses the JSON response', async () => {
    let received: Parameters<GeminiClient['models']['generateContent']>[0] | undefined;
    const client: GeminiClient = {
      models: {
        generateContent: async (params) => {
          received = params;
          return { text: '{"scene":"a red barn"}' };
        },
      },
    };

    const adapter = createGeminiTextAdapter({ client });
    const result = await adapter.generate({ prompt: 'describe a barn', params: { systemPrompt: 'be terse' }, seed: 5 });

    expect(received?.contents).toBe('describe a barn');
    expect(received?.model).toBe('gemini-2.5-flash');
    expect(received?.config).toMatchObject({
      responseMimeType: 'application/json',
      systemInstruction: 'be terse',
      seed: 5,
    });
    expect(result.payload).toEqual({ scene: 'a red barn' });
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.seed).toBe(5);
  });

  it('throws a non-retryable error when no Google credentials are configured', async () => {
    vi.stubEnv('GEMINI_API_KEY', undefined as unknown as string);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined as unknown as string);
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined as unknown as string);

    const adapter = createGeminiTextAdapter();
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'GEMINI_API_KEY_MISSING',
      retryable: false,
    });
  });

  it('maps a 400 to a non-retryable error and a 500 to a retryable one', async () => {
    const rejecting = (status: number): GeminiClient => ({
      models: {
        generateContent: async () => {
          throw apiError(status);
        },
      },
    });

    await expect(createGeminiTextAdapter({ client: rejecting(400) }).generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'GEMINI_GENERATION_FAILED',
      retryable: false,
    });

    const on500 = createGeminiTextAdapter({ client: rejecting(500) });
    await expect(on500.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'GEMINI_GENERATION_FAILED',
      retryable: true,
    });
    await expect(on500.generate({ prompt: 'x' })).rejects.toBeInstanceOf(InferenceError);
  });

  it('treats an error with no numeric status as a retryable transport failure', async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => {
          throw new Error('ECONNRESET');
        },
      },
    };
    await expect(createGeminiTextAdapter({ client }).generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'GEMINI_UNREACHABLE',
      retryable: true,
    });
  });

  it('throws GEMINI_NOT_JSON when the model output is not valid JSON', async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => ({ text: 'not json' }),
      },
    };
    await expect(createGeminiTextAdapter({ client }).generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'GEMINI_NOT_JSON',
    });
  });

  it('throws GEMINI_NO_TEXT when the response has no text', async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => ({}),
      },
    };
    await expect(createGeminiTextAdapter({ client }).generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'GEMINI_NO_TEXT',
    });
  });
});

describe('createImagenAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osai-inference-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const imageResponse = (base64: string) => ({
    candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { data: base64, mimeType: 'image/png' } }] } }],
  });

  it('extracts inline image data from generateContent and writes the PNG under mediaDir', async () => {
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex'); // just needs to round-trip through base64
    let received: Parameters<GeminiClient['models']['generateContent']>[0] | undefined;
    const client: GeminiClient = {
      models: {
        generateContent: async (params) => {
          received = params;
          return imageResponse(pngBytes.toString('base64'));
        },
      },
    };

    const adapter = createImagenAdapter({ client, mediaDir: join(dir, 'media') });
    const result = await adapter.generate({ prompt: 'a red barn' });

    expect(received?.contents).toBe('a red barn');
    expect(received?.model).toBe('gemini-2.5-flash-image');
    expect(received?.config).toMatchObject({ responseModalities: ['IMAGE'] });
    const payload = result.payload as { filePath: string; width: number; height: number };
    expect(payload).toMatchObject({ width: 1024, height: 1024 });
    const stats = await stat(payload.filePath);
    expect(stats.size).toBe(pngBytes.length);
  });

  it('folds a non-default aspect ratio into the prompt and reports its nominal dimensions', async () => {
    let received: Parameters<GeminiClient['models']['generateContent']>[0] | undefined;
    const client: GeminiClient = {
      models: {
        generateContent: async (params) => {
          received = params;
          return imageResponse(Buffer.from('ff', 'hex').toString('base64'));
        },
      },
    };
    const adapter = createImagenAdapter({ client, mediaDir: join(dir, 'media'), aspectRatio: '16:9' });
    const result = await adapter.generate({ prompt: 'x' });
    expect(received?.contents).toContain('16:9');
    expect(result.payload).toMatchObject({ width: 1344, height: 768 });
  });

  it('throws IMAGEN_NO_IMAGE when the response has no inline image part', async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => ({ candidates: [{ content: { parts: [{ text: 'no image, sorry' }] } }] }),
      },
    };
    const adapter = createImagenAdapter({ client, mediaDir: join(dir, 'media') });
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'IMAGEN_NO_IMAGE', retryable: true });
  });

  it('maps a 503 to a retryable IMAGEN_GENERATION_FAILED', async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => {
          throw apiError(503);
        },
      },
    };
    const adapter = createImagenAdapter({ client, mediaDir: join(dir, 'media') });
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'IMAGEN_GENERATION_FAILED',
      retryable: true,
    });
  });
});
