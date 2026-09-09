import { createServer, type Server } from 'node:http';
import { writeFile as writeFileFs } from 'node:fs/promises';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createLocalImageAdapter } from '../src/local-image-adapter.js';

/**
 * Real generation (mflux + a multi-GB model, warmed up in a persistent process) is
 * manually smoke-tested, not run in the suite — see packages/inference/README.md.
 * This stubs the server the adapter talks to over HTTP, to check the adapter's own
 * logic: request shape, output path, error handling.
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

describe('createLocalImageAdapter', () => {
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
      await writeFileFs(body.output, 'stub-image-bytes');
      return { status: 200, body: { ok: true } };
    });

    try {
      const adapter = createLocalImageAdapter({
        mediaDir: join(dir, 'media'),
        port: stub.port,
        model: 'schnell',
        steps: 4,
        width: 512,
        height: 512,
      });

      const result = await adapter.generate({ prompt: 'a red barn', seed: 7 });

      expect(received).toMatchObject({ prompt: 'a red barn', seed: 7, steps: 4, width: 512, height: 512 });
      expect(result.model).toBe('schnell');
      expect(result.seed).toBe(7);
      const payload = result.payload as { filePath: string; width: number; height: number };
      expect(payload.width).toBe(512);
      expect(payload.height).toBe(512);
      await expect(stat(payload.filePath)).resolves.toBeDefined();
    } finally {
      await stub.close();
    }
  });

  it('throws a retryable InferenceError when the server reports failure', async () => {
    const stub = await startStubServer(async () => ({ status: 500, body: { ok: false, error: 'boom' } }));

    try {
      const adapter = createLocalImageAdapter({ mediaDir: join(dir, 'media'), port: stub.port });

      await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toBeInstanceOf(InferenceError);
      await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toMatchObject({
        code: 'IMAGE_GENERATION_FAILED',
        retryable: true,
      });
    } finally {
      await stub.close();
    }
  });

  it('throws a retryable InferenceError when the server is unreachable', async () => {
    // Nothing listening on this port.
    const adapter = createLocalImageAdapter({ mediaDir: join(dir, 'media'), port: 1 });

    await expect(adapter.generate({ prompt: 'a red barn' })).rejects.toMatchObject({
      code: 'IMAGE_SERVER_UNREACHABLE',
      retryable: true,
    });
  });
});
