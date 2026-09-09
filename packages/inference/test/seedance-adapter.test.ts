import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createSeedanceImageAdapter, createSeedanceVideoAdapter } from '../src/seedance-adapter.js';

const run = promisify(execFile);

/**
 * The real seedance_server.py loads a PyTorch model and is slow to start —
 * manually smoke-tested (see packages/inference/README.md and
 * research/seedance-model/README.md), not run in this suite. This stubs the
 * server the adapter talks to over HTTP, mirroring local-image-adapter.test.ts,
 * to check the adapter's own logic: request shape, output handling, error
 * mapping, and (for video) the real ffmpeg frame-stitching step.
 */
function startStubServer(handler: (body: any) => Promise<{ status: number; body: unknown }>): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        const { status, body } = await handler(raw ? JSON.parse(raw) : {});
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function writeSyntheticPng(path: string): Promise<void> {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', path]);
}

describe('createSeedanceImageAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osai-inference-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the expected request body and returns the output path', async () => {
    let received: any;
    const stub = await startStubServer(async (body) => {
      received = body;
      await writeSyntheticPng(body.output);
      return { status: 200, body: { ok: true } };
    });

    try {
      const adapter = createSeedanceImageAdapter({ mediaDir: join(dir, 'media'), port: stub.port, steps: 12 });
      const result = await adapter.generate({ prompt: 'a red barn', seed: 7 });

      expect(received).toMatchObject({ prompt: 'a red barn', modality: 'image', steps: 12, seed: 7 });
      expect(received.referenceImagePath).toBeUndefined();
      expect(result.model).toBe('seedance-style-dit-untrained');
      expect(result.seed).toBe(7);
      const payload = result.payload as { filePath: string };
      await expect(stat(payload.filePath)).resolves.toBeDefined();
    } finally {
      await stub.close();
    }
  });

  it('forwards params.referenceImagePath when given', async () => {
    let received: any;
    const stub = await startStubServer(async (body) => {
      received = body;
      await writeSyntheticPng(body.output);
      return { status: 200, body: { ok: true } };
    });

    try {
      const adapter = createSeedanceImageAdapter({ mediaDir: join(dir, 'media'), port: stub.port });
      await adapter.generate({ prompt: 'a red barn', params: { referenceImagePath: '/tmp/ref.png' } });

      expect(received.referenceImagePath).toBe('/tmp/ref.png');
    } finally {
      await stub.close();
    }
  });

  it('throws a retryable InferenceError when the server reports failure', async () => {
    const stub = await startStubServer(async () => ({ status: 500, body: { ok: false, error: 'boom' } }));

    try {
      const adapter = createSeedanceImageAdapter({ mediaDir: join(dir, 'media'), port: stub.port });
      await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toMatchObject({
        code: 'SEEDANCE_GENERATION_FAILED',
        retryable: true,
      });
    } finally {
      await stub.close();
    }
  });

  it('throws a retryable InferenceError when the server is unreachable', async () => {
    const adapter = createSeedanceImageAdapter({ mediaDir: join(dir, 'media'), port: 1 });

    await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toMatchObject({
      code: 'SEEDANCE_SERVER_UNREACHABLE',
      retryable: true,
    });
    await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toBeInstanceOf(InferenceError);
  });
});

describe('createSeedanceVideoAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osai-inference-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stitches sampled frames into an mp4 and deletes the intermediate frames', async () => {
    let received: any;
    const stub = await startStubServer(async (body) => {
      received = body;
      const stem = body.output.replace(/\.mp4$/, '');
      const framePaths: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const p = `${stem}_frame${String(i).padStart(3, '0')}.png`;
        await writeSyntheticPng(p);
        framePaths.push(p);
      }
      return { status: 200, body: { ok: true, framePaths } };
    });

    try {
      const adapter = createSeedanceVideoAdapter({ mediaDir: join(dir, 'media'), port: stub.port, fps: 3 });
      const result = await adapter.generate({ prompt: 'a red barn', seed: 3 });

      expect(received).toMatchObject({ prompt: 'a red barn', modality: 'video', seed: 3 });
      const payload = result.payload as { filePath: string; durationSeconds: number };
      expect(payload.durationSeconds).toBeCloseTo(1, 5); // 3 frames / 3 fps
      const stats = await stat(payload.filePath);
      expect(stats.size).toBeGreaterThan(0);

      // Intermediate frame files should be cleaned up after stitching.
      await expect(
        stat(`${payload.filePath.replace(/\.mp4$/, '')}_frame000.png`),
      ).rejects.toThrow();
    } finally {
      await stub.close();
    }
  });

  it('throws a retryable InferenceError when the server is unreachable', async () => {
    const adapter = createSeedanceVideoAdapter({ mediaDir: join(dir, 'media'), port: 1 });

    await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toMatchObject({
      code: 'SEEDANCE_SERVER_UNREACHABLE',
      retryable: true,
    });
  });
});
