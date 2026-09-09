import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEnvFile } from 'node:process';

import { serve } from '@hono/node-server';
import { startImageServer, type ImageServerHandle } from '@osai/inference';

import { createContext } from './context.js';
import { createApp } from './routes.js';

// Picks up GEMINI_API_KEY / OSAI_PROVIDER etc. from apps/server/.env if present
// (gitignored — see .env.example). No-op if the file doesn't exist.
try {
  loadEnvFile();
} catch {
  // No .env file — fine, real env vars (or the fake-adapter defaults) still work.
}

const imageServerPort = Number(process.env.OSAI_IMAGE_SERVER_PORT ?? 8765);
const provider = process.env.OSAI_PROVIDER === 'gemini' ? 'gemini' : 'local';

// A failed/missing local model (no weights cached, no HF auth, no GPU, etc.)
// must not take down the whole API — createLocalImageAdapter already handles
// an unreachable image server per-request (throws a retryable
// IMAGE_SERVER_UNREACHABLE InferenceError), so the rest of the app — project
// creation, scripts, everything that isn't actually generating an image —
// keeps working. Only image-generation jobs fail, and they retry per the
// job queue's normal retry policy once the model server is available again.
// Skipped entirely under the 'gemini' provider — Imagen replaces it, and
// starting it anyway would just fail trying to load the (currently missing)
// local FLUX weights for nothing.
let imageServer: ImageServerHandle | null = null;
if (provider === 'local') {
  console.log('Starting local image generation server (loading model, this happens once)...');
  try {
    imageServer = await startImageServer({ port: imageServerPort });
    console.log(`Image server ready at ${imageServer.url}`);
  } catch (err) {
    console.error('Image server failed to start — continuing without real image generation.');
    console.error(err instanceof Error ? err.message : String(err));
  }
} else {
  console.log('OSAI_PROVIDER=gemini — using Gemini/Imagen for text/image, skipping local model server.');
}

const projectsDir = process.env.OSAI_PROJECTS_DIR ?? './data/projects';
const jobsDbPath = process.env.OSAI_JOBS_DB ?? './data/jobs.sqlite';
const mediaDir = process.env.OSAI_MEDIA_DIR ?? './data/media';

// Cloud Run starts from a clean container — SqliteJobStore won't create its
// parent dir, so make sure all three state dirs exist before wiring anything.
for (const dir of [projectsDir, dirname(jobsDbPath), mediaDir]) {
  mkdirSync(dir, { recursive: true });
}

const ctx = createContext({
  projectsDir,
  jobsDbPath,
  mediaDir,
  imageServerPort,
  provider,
});

// Real generation work only happens once the queue is polling — the pipeline
// endpoints work without this, but nothing ever moves off 'queued'.
ctx.queue.start();

const app = createApp(ctx);
const port = Number(process.env.PORT ?? 3000);

const httpServer = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OSAI server listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    imageServer?.stop();
    httpServer.close();
    process.exit(0);
  });
}
