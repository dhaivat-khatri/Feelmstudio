import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createKenBurnsVideoAdapter } from '../src/kenburns-video-adapter.js';

const run = promisify(execFile);

describe('createKenBurnsVideoAdapter', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osai-inference-'));
    imagePath = join(dir, 'source.png');
    // A synthetic still image via ffmpeg's own test-pattern source — no model, no
    // download, so this test stays fast and hermetic.
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', imagePath]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders a zoom/pan mp4 from the source image', async () => {
    const adapter = createKenBurnsVideoAdapter({ mediaDir: join(dir, 'out'), durationSeconds: 1, fps: 10 });

    const result = await adapter.generate({ prompt: 'unused', params: { imagePath } });

    const payload = result.payload as { filePath: string; durationSeconds: number; motion: string };
    expect(payload.durationSeconds).toBe(1);
    expect(payload.motion).toBe('zoomIn');
    expect(result.model).toBe('kenburns-ffmpeg');
    const stats = await stat(payload.filePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it.each([
    ['a slow zoom out over the lighthouse', 'zoomOut'],
    ['pan left across the harbor', 'panLeft'],
    ['pan right along the coast', 'panRight'],
    ['tilt up to reveal the sky', 'panUp'],
    ['pan down to the water', 'panDown'],
    ['a lighthouse at sunset', 'zoomIn'],
  ])('picks the camera move matching the prompt: %s -> %s', async (prompt, expected) => {
    const adapter = createKenBurnsVideoAdapter({ mediaDir: join(dir, 'out'), durationSeconds: 1, fps: 10 });

    const result = await adapter.generate({ prompt, params: { imagePath } });

    expect((result.payload as { motion: string }).motion).toBe(expected);
  });

  it('rejects when params.imagePath is missing', async () => {
    const adapter = createKenBurnsVideoAdapter({ mediaDir: join(dir, 'out') });

    await expect(adapter.generate({ prompt: 'unused' })).rejects.toThrow(InferenceError);
  });

  it('fails with a retryable InferenceError when the source image does not exist', async () => {
    const adapter = createKenBurnsVideoAdapter({ mediaDir: join(dir, 'out') });

    await expect(
      adapter.generate({ prompt: 'unused', params: { imagePath: join(dir, 'missing.png') } }),
    ).rejects.toMatchObject({ code: 'VIDEO_GENERATION_FAILED', retryable: true });
  });
});
