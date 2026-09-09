import { dirname, join } from 'node:path';

import { systemRuntime, type AgentRegistry, type Runtime } from '@osai/core';
import {
  createFakeAdapterRegistry,
  createGeminiTextAdapter,
  createImagenAdapter,
  createInferenceExecutor,
  createLocalImageAdapter,
  createKenBurnsVideoAdapter,
  createLocalTextAdapter,
  createLyriaMusicAdapter,
  createParallelResearchAdapter,
  createVeoVideoAdapter,
  type Capability,
  type InferenceAdapter,
  type ProjectLookup,
  type ResearchAdapter,
} from '@osai/inference';
import { InMemoryNotificationSink, JobQueue, SqliteJobStore } from '@osai/jobs';
import { FileProjectStore, ProjectRepository } from '@osai/persistence';

import { createCinematographerAgent, createComposerAgent } from './agents.js';
import { createCraftMemoryStore, type CraftMemoryStore } from './craft-memory.js';

export interface AppContext {
  readonly rt: Runtime;
  readonly repo: ProjectRepository;
  readonly jobStore: SqliteJobStore;
  readonly queue: JobQueue;
  readonly notify: InMemoryNotificationSink;
  readonly mediaDir: string;
  /** The 'text' capability adapter, direct — the Director builds its own per-request Agent from this. */
  readonly textAdapter: InferenceAdapter;
  /** The 'music' capability adapter, direct — `/music/render` calls it synchronously, not via the queue. */
  readonly musicAdapter: InferenceAdapter;
  /** Parallel Search client for the Researcher step (not job-queue-routed). */
  readonly researchAdapter: ResearchAdapter;
  /** Cross-project craft lessons the agents carry (the Rooms tab feeds this). */
  readonly craftMemory: CraftMemoryStore;
  /** Statically-registrable crew (currently just the Cinematographer; Director is per-request, see routes.ts). */
  readonly agents: AgentRegistry;
  /** Built React app to serve (from `OSAI_WEB_DIR`). Unset in dev/tests — Vite serves the SPA then. */
  readonly webDir?: string;
}

export interface AppContextOptions {
  readonly projectsDir?: string;
  /** SQLite location for the job store — a file path, or ':memory:' for tests. */
  readonly jobsDbPath?: string;
  /** Directory generated images/video are written to. */
  readonly mediaDir?: string;
  /** Port the persistent image server (started separately, see server.ts) is listening on. */
  readonly imageServerPort?: number;
  /**
   * Which text/image provider to wire up. 'local' (default) uses the on-device
   * mflux/mlx-lm adapters; 'gemini' calls real Gemini/Imagen instead — via Vertex
   * AI (GOOGLE_CLOUD_PROJECT + ADC) or AI Studio (GEMINI_API_KEY), see
   * gemini-adapter.ts. Falls back to OSAI_PROVIDER if unset. Video stays on the
   * local ffmpeg Ken Burns adapter either way — no Gemini video adapter yet.
   */
  readonly provider?: 'local' | 'gemini';
  /**
   * Override the default adapter registry (real local image + Ken Burns video,
   * fake text/speech/music). Tests substitute an all-fake registry so they stay
   * fast and don't need mflux/ffmpeg or a network connection.
   */
  readonly adapters?: ReadonlyMap<Capability, InferenceAdapter>;
  /** Override the Parallel research adapter (tests pass a fake — no network). */
  readonly researchAdapter?: ResearchAdapter;
  /** Override craft memory (tests pass an in-memory store — no disk). */
  readonly craftMemory?: CraftMemoryStore;
  /** Directory of the built React app to serve. Falls back to `OSAI_WEB_DIR`. */
  readonly webDir?: string;
  /** 'kenburns' (default) or 'veo' for real image-to-video. Falls back to OSAI_VIDEO. */
  readonly video?: 'kenburns' | 'veo';
  readonly rt?: Runtime;
  readonly concurrency?: number;
}

/**
 * Wires the whole stack together: a file-backed project repository, a SQLite-backed
 * job queue, and the fake-only inference executor from @osai/inference. This is the
 * one place in the codebase that knows about all four packages at once — everything
 * downstream of here only sees `AppContext`.
 */
export function createContext(options: AppContextOptions = {}): AppContext {
  const rt = options.rt ?? systemRuntime();
  const repo = new ProjectRepository(new FileProjectStore(options.projectsDir ?? './data/projects'), rt);

  // ProjectRepository's method is `load`, not `get` — @osai/inference's ProjectLookup
  // is a minimal structural port so it never needed to know that, but the shapes
  // don't match by name, so the seam needs this one-line adapter.
  const projects: ProjectLookup = {
    get: (id) => repo.load(id),
    save: (project) => repo.save(project),
  };

  const jobStore = new SqliteJobStore(options.jobsDbPath ?? ':memory:');
  const notify = new InMemoryNotificationSink();

  // Real generation for image/video/text (see @osai/inference's README); speech
  // and music stay on the fake adapter until those get the same treatment.
  // 'gemini' swaps text/image onto the real Gemini/Imagen APIs; video stays on
  // the local ffmpeg Ken Burns adapter under both providers.
  const mediaDir = options.mediaDir ?? './data/media';
  const provider = options.provider ?? (process.env.OSAI_PROVIDER === 'gemini' ? 'gemini' : 'local');
  const adapters =
    options.adapters ??
    (() => {
      const registry = new Map<Capability, InferenceAdapter>(createFakeAdapterRegistry());
      if (provider === 'gemini') {
        registry.set('text', createGeminiTextAdapter());
        registry.set('image', createImagenAdapter({ mediaDir }));
        registry.set('music', createLyriaMusicAdapter({ mediaDir }));
      } else {
        registry.set(
          'image',
          createLocalImageAdapter({ mediaDir, ...(options.imageServerPort !== undefined && { port: options.imageServerPort }) }),
        );
        registry.set('text', createLocalTextAdapter());
      }
      // Video: Ken Burns (pan/zoom on the still) by default. `OSAI_VIDEO=veo`
      // swaps in real Veo 3 Fast image-to-video — paid (~$1.20 / 8s clip) and
      // slow (1–3 min), so it stays opt-in.
      const useVeo = (options.video ?? process.env.OSAI_VIDEO) === 'veo';
      registry.set('video', useVeo ? createVeoVideoAdapter({ mediaDir }) : createKenBurnsVideoAdapter({ mediaDir }));
      return registry;
    })();
  const executor = createInferenceExecutor(adapters, projects);
  const queue = new JobQueue(jobStore, rt, {
    executor,
    notify,
    concurrency: options.concurrency ?? 2,
  });

  // Same adapter instance the job queue would use for a 'text' job — tests that
  // override `adapters` with an all-fake registry get a fake text adapter here too,
  // so the agent routes stay just as fast/offline as the rest of the test suite.
  const textAdapter = adapters.get('text');
  if (!textAdapter) throw new Error('No adapter registered for the "text" capability');
  // The Composer's soundtrack render (`/music/render`) calls this directly, not
  // via the job queue — the same instance the queue would use for a 'music' job.
  const musicAdapter = adapters.get('music');
  if (!musicAdapter) throw new Error('No adapter registered for the "music" capability');

  // Parallel Search — the Researcher step. Real client by default (reads
  // PARALLEL_API_KEY); tests inject a fake so they stay offline.
  const researchAdapter = options.researchAdapter ?? createParallelResearchAdapter();

  const craftMemory =
    options.craftMemory ??
    createCraftMemoryStore({
      filePath: process.env.OSAI_CRAFT_MEMORY ?? join(dirname(mediaDir), 'craft-memory.json'),
      now: () => rt.clock.now(),
      nextId: () => rt.ids.next('learn'),
    });
  const agents: AgentRegistry = {
    scenePlan: createCinematographerAgent(textAdapter),
    music: createComposerAgent(textAdapter),
  };

  const webDir = options.webDir ?? process.env.OSAI_WEB_DIR;

  return {
    rt,
    repo,
    jobStore,
    queue,
    notify,
    mediaDir,
    textAdapter,
    musicAdapter,
    researchAdapter,
    craftMemory,
    agents,
    ...(webDir && { webDir }),
  };
}
