import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

/** The venv this package installs mflux into (see packages/inference/README.md). */
const DEFAULT_PYTHON_BIN = fileURLToPath(new URL('../.venv/bin/python3', import.meta.url));
const DEFAULT_IMAGE_SERVER_SCRIPT = fileURLToPath(new URL('../python/image_server.py', import.meta.url));
const DEFAULT_PORT = 8765;

export interface LocalImageAdapterOptions {
  /** Directory generated images are written to. */
  readonly mediaDir: string;
  /** Port the persistent image server (see startImageServer) is listening on. */
  readonly port?: number;
  readonly model?: string;
  readonly quantize?: number;
  readonly steps?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface ImagePayload {
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Real, local, zero-cost image generation via mflux (runs FLUX-family models on
 * Apple Silicon through MLX) — talking to the persistent server started by
 * `startImageServer`, not spawning a fresh process per call. A fresh
 * `mflux-generate` process pays a fixed ~15-20s cost every single time (weight
 * load + Metal kernel compilation) regardless of image size; the server pays that
 * once at startup and reuses the warm process, see packages/inference/README.md.
 */
export function createLocalImageAdapter(options: LocalImageAdapterOptions): InferenceAdapter {
  const port = options.port ?? DEFAULT_PORT;
  const steps = options.steps ?? 4;
  const width = options.width ?? 512;
  const height = options.height ?? 512;

  return {
    capability: 'image',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      await mkdir(options.mediaDir, { recursive: true });
      const outPath = join(options.mediaDir, `${crypto.randomUUID()}.png`);

      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${port}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: request.prompt,
            steps,
            width,
            height,
            output: outPath,
            ...(request.seed !== undefined && { seed: request.seed }),
          }),
        });
      } catch (err) {
        throw new InferenceError({
          code: 'IMAGE_SERVER_UNREACHABLE',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        });
      }

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : res.statusText;
        throw new InferenceError({ code: 'IMAGE_GENERATION_FAILED', message, retryable: true });
      }

      const payload: ImagePayload = { filePath: outPath, width, height };
      return { payload, model: options.model ?? 'schnell', ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}

export interface ImageServerHandle {
  readonly url: string;
  stop(): void;
}

export interface StartImageServerOptions {
  readonly port?: number;
  readonly model?: string;
  readonly quantize?: number;
  readonly pythonBin?: string;
  readonly scriptPath?: string;
  /** How long to wait for the model to load + warm up before giving up. */
  readonly readyTimeoutMs?: number;
}

/**
 * Spawns the persistent image server (packages/inference/python/image_server.py),
 * streams its logs through, and resolves once it responds to /health — i.e. once
 * the model is loaded and its first (kernel-warming) generation has completed.
 * Call `stop()` on shutdown so this doesn't leak an orphaned Python process.
 */
export async function startImageServer(options: StartImageServerOptions = {}): Promise<ImageServerHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
  const scriptPath = options.scriptPath ?? DEFAULT_IMAGE_SERVER_SCRIPT;
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;

  const child = spawn(
    pythonBin,
    [
      scriptPath,
      '--port', String(port),
      '--model', options.model ?? 'schnell',
      '--quantize', String(options.quantize ?? 4),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`image_server.py exited early (code ${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // Not listening yet — expected while the model loads. Keep polling.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  child.kill();
  throw new Error(`image_server.py did not become ready within ${readyTimeoutMs}ms`);
}
