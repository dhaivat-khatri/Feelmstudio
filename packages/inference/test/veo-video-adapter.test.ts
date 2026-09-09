import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createVeoVideoAdapter } from '../src/veo-video-adapter.js';

/**
 * Veo is async: `:predictLongRunning` returns an operation name, then you poll
 * `:fetchPredictOperation` until `done`. Unit-tested with an injected `fetchImpl`
 * + `getAccessToken` — no network, no credentials, no polling delay (interval 0).
 * The one real paid call is smoke-tested manually with user go-ahead.
 */
const mp4 = Buffer.from('\x00\x00\x00\x18ftypmp42', 'binary');

let dir: string;
let imagePath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osai-veo-'));
  imagePath = join(dir, 'frame.png');
  await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake fetch that answers the start call once, then N polls (last one `done`). */
function scriptedFetch(opts: { pollsUntilDone?: number; startStatus?: number; videoField?: 'bytesBase64Encoded' | 'video' } = {}) {
  const pollsUntilDone = opts.pollsUntilDone ?? 1;
  const field = opts.videoField ?? 'bytesBase64Encoded';
  let polls = 0;
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith(':predictLongRunning')) {
      if (opts.startStatus && opts.startStatus >= 400) {
        return new Response(JSON.stringify({ error: 'nope' }), { status: opts.startStatus });
      }
      return new Response(JSON.stringify({ name: 'projects/p/operations/op-1' }), { status: 200 });
    }
    if (u.endsWith(':fetchPredictOperation')) {
      polls += 1;
      if (polls < pollsUntilDone) return new Response(JSON.stringify({ done: false }), { status: 200 });
      const videoObj =
        field === 'video'
          ? { video: { bytesBase64Encoded: mp4.toString('base64') } }
          : { bytesBase64Encoded: mp4.toString('base64') };
      return new Response(JSON.stringify({ done: true, response: { videos: [videoObj] } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, pollCount: () => polls };
}

describe('createVeoVideoAdapter', () => {
  it('starts a long-running job with the prompt + first-frame image, polls, and writes the mp4', async () => {
    const s = scriptedFetch({ pollsUntilDone: 3 });
    const adapter = createVeoVideoAdapter({
      mediaDir: join(dir, 'out'),
      project: 'proj-x',
      fetchImpl: s.fetchImpl,
      getAccessToken: async () => 'tok',
      pollIntervalMs: 0,
    });

    const result = await adapter.generate({ prompt: 'the chaiwala pours the last cup, steam rising', params: { imagePath } });

    const start = s.calls.find((c) => c.endsWith(':predictLongRunning'))!;
    expect(start).toContain('veo-3.1-fast-generate-001');
    expect(start).toContain('projects/proj-x/');
    expect(s.pollCount()).toBe(3);

    const payload = result.payload as { filePath: string; durationSeconds: number };
    expect(payload.filePath.endsWith('.mp4')).toBe(true);
    expect(await readFile(payload.filePath)).toEqual(mp4);
    expect(result.model).toBe('veo-3.1-fast-generate-001');
  });

  it('sends the prompt and base64 image in the instances body', async () => {
    let body: any;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith(':predictLongRunning')) {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ name: 'op' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: mp4.toString('base64') }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await createVeoVideoAdapter({
      mediaDir: join(dir, 'o'),
      project: 'p',
      fetchImpl,
      getAccessToken: async () => 't',
      pollIntervalMs: 0,
    }).generate({ prompt: 'a shot', params: { imagePath } });

    expect(body.instances[0].prompt).toBe('a shot');
    expect(body.instances[0].image.bytesBase64Encoded).toBe(Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'));
    expect(body.instances[0].image.mimeType).toBe('image/png');
    expect(body.parameters).toMatchObject({ sampleCount: 1 });
  });

  it('accepts the nested { video: { bytesBase64Encoded } } response shape too', async () => {
    const s = scriptedFetch({ videoField: 'video' });
    const adapter = createVeoVideoAdapter({
      mediaDir: join(dir, 'o'),
      project: 'p',
      fetchImpl: s.fetchImpl,
      getAccessToken: async () => 't',
      pollIntervalMs: 0,
    });
    const result = await adapter.generate({ prompt: 'x', params: { imagePath } });
    expect(await readFile((result.payload as { filePath: string }).filePath)).toEqual(mp4);
  });

  it('requires params.imagePath (image-to-video only)', async () => {
    const s = scriptedFetch();
    const adapter = createVeoVideoAdapter({ mediaDir: join(dir, 'o'), project: 'p', fetchImpl: s.fetchImpl, getAccessToken: async () => 't' });
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'MISSING_IMAGE', retryable: false });
  });

  it('maps a 429 start to a retryable error and a 400 to non-retryable', async () => {
    const mk = (status: number) =>
      createVeoVideoAdapter({
        mediaDir: join(dir, 'o'),
        project: 'p',
        getAccessToken: async () => 't',
        fetchImpl: scriptedFetch({ startStatus: status }).fetchImpl,
        pollIntervalMs: 0,
      }).generate({ prompt: 'x', params: { imagePath } });
    await expect(mk(429)).rejects.toMatchObject({ code: 'VEO_GENERATION_FAILED', retryable: true });
    await expect(mk(400)).rejects.toMatchObject({ code: 'VEO_GENERATION_FAILED', retryable: false });
    await expect(mk(400)).rejects.toBeInstanceOf(InferenceError);
  });

  it('times out (retryable) if the operation never finishes', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith(':predictLongRunning')) return new Response(JSON.stringify({ name: 'op' }), { status: 200 });
      return new Response(JSON.stringify({ done: false }), { status: 200 }); // never done
    }) as unknown as typeof fetch;
    const adapter = createVeoVideoAdapter({
      mediaDir: join(dir, 'o'),
      project: 'p',
      fetchImpl,
      getAccessToken: async () => 't',
      pollIntervalMs: 1,
      timeoutMs: 20,
    });
    await expect(adapter.generate({ prompt: 'x', params: { imagePath } })).rejects.toMatchObject({
      code: 'VEO_TIMEOUT',
      retryable: true,
    });
  });

  it('errors non-retryably when no project is configured', async () => {
    const prev = process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    try {
      const adapter = createVeoVideoAdapter({
        mediaDir: join(dir, 'o'),
        getAccessToken: async () => 't',
        fetchImpl: scriptedFetch().fetchImpl,
      });
      await expect(adapter.generate({ prompt: 'x', params: { imagePath } })).rejects.toMatchObject({
        code: 'VEO_PROJECT_MISSING',
        retryable: false,
      });
    } finally {
      if (prev !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prev;
    }
  });
});
