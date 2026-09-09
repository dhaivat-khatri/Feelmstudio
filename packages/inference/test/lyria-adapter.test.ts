import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createLyriaMusicAdapter } from '../src/lyria-adapter.js';

/**
 * Unit-tested with an injected `fetchImpl` + `getAccessToken` — no network, no
 * Google credentials. Shape from docs.cloud.google.com/vertex-ai (lyria-002
 * `:predict`, response `{ predictions: [{ audioContent | bytesBase64Encoded }] }`).
 * The one real paid call is smoke-tested manually with user go-ahead.
 */
const wav = Buffer.from('RIFF....WAVEfmt ', 'ascii'); // arbitrary bytes, just round-trips through base64

const okFetch = (predictions: unknown[]): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ predictions }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osai-lyria-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createLyriaMusicAdapter', () => {
  it('POSTs the prompt to lyria-002:predict with a bearer token and writes the WAV', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({ predictions: [{ audioContent: wav.toString('base64'), mimeType: 'audio/wav' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const adapter = createLyriaMusicAdapter({
      mediaDir: join(dir, 'media'),
      project: 'proj-x',
      fetchImpl,
      getAccessToken: async () => 'tok-123',
    });
    const result = await adapter.generate({ prompt: 'gentle acoustic folk, ukulele, slow, nostalgic' });

    expect(seen?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-x/locations/us-central1/publishers/google/models/lyria-002:predict',
    );
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    const body = JSON.parse(String(seen?.init.body));
    expect(body.instances[0].prompt).toBe('gentle acoustic folk, ukulele, slow, nostalgic');
    expect(body.parameters).toMatchObject({ sample_count: 1 });

    const payload = result.payload as { filePath: string; mimeType: string; durationSeconds: number };
    expect(payload.mimeType).toBe('audio/wav');
    expect(payload.filePath.endsWith('.wav')).toBe(true);
    expect(await readFile(payload.filePath)).toEqual(wav);
  });

  it('accepts the alternative bytesBase64Encoded field name', async () => {
    const adapter = createLyriaMusicAdapter({
      mediaDir: join(dir, 'media'),
      project: 'p',
      fetchImpl: okFetch([{ bytesBase64Encoded: wav.toString('base64') }]),
      getAccessToken: async () => 't',
    });
    const result = await adapter.generate({ prompt: 'x' });
    expect(await readFile((result.payload as { filePath: string }).filePath)).toEqual(wav);
  });

  it('sends seed instead of sample_count when a seed is given (they are mutually exclusive)', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ predictions: [{ audioContent: wav.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const adapter = createLyriaMusicAdapter({ mediaDir: join(dir, 'm'), project: 'p', fetchImpl, getAccessToken: async () => 't' });
    await adapter.generate({ prompt: 'x', seed: 42 });
    expect(body!.instances).toMatchObject([{ seed: 42 }]);
    expect(body!.parameters ?? {}).not.toHaveProperty('sample_count');
  });

  it('maps 429/5xx to retryable and other 4xx to non-retryable', async () => {
    const on = (status: number) =>
      createLyriaMusicAdapter({
        mediaDir: join(dir, 'm'),
        project: 'p',
        getAccessToken: async () => 't',
        fetchImpl: (async () => new Response(JSON.stringify({ error: 'x' }), { status })) as unknown as typeof fetch,
      }).generate({ prompt: 'x' });

    await expect(on(429)).rejects.toMatchObject({ code: 'LYRIA_GENERATION_FAILED', retryable: true });
    await expect(on(503)).rejects.toMatchObject({ code: 'LYRIA_GENERATION_FAILED', retryable: true });
    await expect(on(400)).rejects.toMatchObject({ code: 'LYRIA_GENERATION_FAILED', retryable: false });
    await expect(on(400)).rejects.toBeInstanceOf(InferenceError);
  });

  it('throws LYRIA_NO_AUDIO when the response has no audio bytes', async () => {
    const adapter = createLyriaMusicAdapter({
      mediaDir: join(dir, 'm'),
      project: 'p',
      getAccessToken: async () => 't',
      fetchImpl: okFetch([{}]),
    });
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'LYRIA_NO_AUDIO', retryable: true });
  });

  it('times out with a retryable error if the call hangs past the deadline', async () => {
    const fetchImpl = (() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const adapter = createLyriaMusicAdapter({
      mediaDir: join(dir, 'm'),
      project: 'p',
      getAccessToken: async () => 't',
      fetchImpl,
      timeoutMs: 30,
    });
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'LYRIA_UNREACHABLE', retryable: true });
  });

  it('throws a non-retryable error when no project is configured', async () => {
    const prev = process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    try {
      const adapter = createLyriaMusicAdapter({ mediaDir: join(dir, 'm'), getAccessToken: async () => 't', fetchImpl: okFetch([]) });
      await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'LYRIA_PROJECT_MISSING', retryable: false });
    } finally {
      if (prev !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prev;
    }
  });
});
