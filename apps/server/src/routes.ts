import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  MUSIC_NODE,
  Project,
  STYLE_NODE,
  SUBTITLES_NODE,
  agentName,
  projectId,
  runNode,
  sceneId as toSceneId,
  scenePartNode,
  type CrewNote,
  type MusicPayload,
  type PersonaRole,
  type ProjectLifecycle,
  type ProposedSegment,
  type ScenePart,
  type ScenePlanPayload,
  type SegmentationDiff,
  type StylePayload,
} from '@osai/core';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Capability, ResearchResult } from '@osai/inference';
import { Hono, type Context } from 'hono';

import {
  createCinematographerAgent,
  createComposerAgent,
  createDirectorAgent,
  generateWriterScript,
  renderMusicTrack,
  runDailies,
  runProductionMeeting,
  runResearch,
  runSceneDeliberation,
  type CrewContext,
  type CrewNoteDraft,
  type SceneReview,
} from './agents.js';
import type { AppContext } from './context.js';

/** Flattens a project's produced state into what the dailies / meeting prompts read. */
function crewContext(project: Project): CrewContext {
  const overview = project.overview();
  const scenes: SceneReview[] = overview.scenes.map((s) => {
    const plan = project.graph.get(scenePartNode(s.sceneId, 'plan'))?.current?.payload as ScenePlanPayload | undefined;
    return {
      sceneId: s.sceneId,
      ordinal: s.ordinal,
      text: String(project.graph.get(scenePartNode(s.sceneId, 'text'))?.current?.payload ?? ''),
      ...(plan?.shotType && { plan: [plan.shotType, plan.framing, plan.cameraMove].filter(Boolean).join(' · ') }),
      hasImage: Boolean(project.graph.get(scenePartNode(s.sceneId, 'image'))?.current),
      hasVideo: Boolean(project.graph.get(scenePartNode(s.sceneId, 'video'))?.current),
    };
  });
  return {
    idea: overview.idea,
    style: overview.style,
    music: overview.music,
    ...(overview.style.runtimeMinutes !== undefined && { runtimeMinutes: overview.style.runtimeMinutes }),
    scenes,
  };
}

const DELIBERATION_ROLES: readonly PersonaRole[] = ['Director', 'Writer', 'Cinematographer', 'Composer', 'Editor'];

/** A deterministic 31-bit seed from a string, so every scene image in one project shares it. */
function stableSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) % 2147483647;
}

/** Run one scene huddle, persist its entries + learnings, return the persisted rows. */
async function deliberateScene(ctx: AppContext, project: Project, scene: ReturnType<typeof toSceneId>) {
  const priorLearnings = Object.fromEntries(
    DELIBERATION_ROLES.map((role) => [role, ctx.craftMemory.forRole(role).map((l) => l.body)]),
  );
  const { entries, learnings } = await runSceneDeliberation(ctx.textAdapter, crewContext(project), scene, priorLearnings);
  const savedEntries = project.addRoomEntries(entries);
  const savedLearnings = ctx.craftMemory.add(
    learnings.map((l) => ({ ...l, sourceProjectId: String(project.id), sourceSceneId: String(scene) })),
  );
  return { entries: savedEntries, learnings: savedLearnings };
}

/** Persists a batch of model-drafted notes onto the project, resolving scene ids. */
function persistNotes(project: Project, drafts: readonly CrewNoteDraft[]): CrewNote[] {
  const known = new Set(project.sceneIds.map(String));
  return drafts.map((d) =>
    project.addNote({
      from: d.from,
      to: d.to,
      sceneId: d.sceneId && known.has(d.sceneId) ? toSceneId(d.sceneId) : null,
      body: d.body,
    }),
  );
}

/** Which generation part maps to which inference capability (app-layer knowledge — neither @osai/core nor @osai/inference needs to know this). */
const PART_TO_CAPABILITY = {
  image: 'image',
  video: 'video',
  narration: 'speech',
} as const satisfies Partial<Record<ScenePart, Capability>>;

type GeneratablePart = keyof typeof PART_TO_CAPABILITY;

const ALL_PARTS: readonly ScenePart[] = ['text', 'plan', 'image', 'video', 'narration'];

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', mp4: 'video/mp4' };

/**
 * The HTTP surface over `AppContext`. Deliberately one file — a dozen or so routes
 * doesn't earn a router-per-resource split yet.
 */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.post('/projects', async (c) => {
    const body = await c.req.json<{ title?: string }>();
    if (!body.title) return c.json({ error: 'title is required' }, 400);

    const project = new Project({ id: projectId(ctx.rt.ids.next('proj')), title: body.title }, ctx.rt);
    await ctx.repo.save(project);
    return c.json(project.overview(), 201);
  });

  app.get('/projects', async (c) => {
    return c.json(await ctx.repo.list());
  });

  app.get('/projects/:id', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    return c.json(project.overview());
  });

  // Pure derivation of the approved script (never re-transcribed audio) — recomputes
  // automatically as scenes change, same as timeline; no generate action, no agent.
  app.get('/projects/:id/subtitles', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    const node = project.graph.get(SUBTITLES_NODE);
    return c.json({ payload: node?.current?.payload ?? null });
  });

  // "What changed and why" — every real version the graph already recorded, across
  // every node, newest first. No new persistence: this is a read over data
  // `addVersion` already writes on every generation (PRD's "AI forgets why" gap).
  app.get('/projects/:id/decisions', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const decisions = project.graph.nodes.flatMap((node) =>
      node.versions.map((v) => ({
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        sceneId: node.sceneId ?? null,
        agent: agentName(node.kind),
        versionIndex: v.index,
        createdAt: v.createdAt,
        authorship: v.provenance.authorship,
        prompt: v.provenance.prompt ?? null,
        model: v.provenance.model ?? null,
        seed: v.provenance.seed ?? null,
      })),
    );
    decisions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    return c.json({ decisions });
  });

  app.post('/projects/:id/script', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ segments?: ProposedSegment[] }>();
    if (!Array.isArray(body.segments) || body.segments.length === 0) {
      return c.json({ error: 'segments must be a non-empty array' }, 400);
    }

    // First segmentation applies directly (no prior work to lose). A later script
    // edit only proposes a diff — the text itself lands, but re-segmentation is
    // never applied silently, so it's returned here for review, not committed.
    if (project.segmentation.length === 0) {
      project.initializeFromScript(body.segments);
      await ctx.repo.save(project);
      return c.json({ applied: true, overview: project.overview() });
    }

    const { diff } = project.editScript(body.segments);
    await ctx.repo.save(project);
    return c.json({ applied: false, diff });
  });

  app.post('/projects/:id/segmentation/apply', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ diff?: SegmentationDiff }>();
    if (!body.diff) return c.json({ error: 'diff is required' }, 400);

    const report = project.applySegmentation(body.diff);
    await ctx.repo.save(project);
    return c.json({ report, overview: project.overview() });
  });

  app.post('/projects/:id/approve-all', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const approved = project.approveAll();
    await ctx.repo.save(project);
    return c.json({ approved, overview: project.overview() });
  });

  // Everything a scene card needs to render: each part's status/staleness plus its
  // current content — script text, and a browser-loadable URL for image/video.
  app.get('/projects/:id/scenes/:sceneId', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const scene = toSceneId(c.req.param('sceneId') ?? '');
    const summary = project.sceneSummary(scene);
    if (!summary) return c.json({ error: 'scene not found' }, 404);

    const parts = Object.fromEntries(
      ALL_PARTS.map((part) => {
        const node = project.graph.get(scenePartNode(scene, part));
        const payload = node?.current?.payload;
        const filePath = (payload as { filePath?: string } | undefined)?.filePath;
        return [
          part,
          {
            status: node?.status ?? 'notStarted',
            staleness: node?.staleness?.kind ?? null,
            failure: node?.failure ?? null,
            payload: payload ?? null,
            ...(filePath && { mediaUrl: `/media/${basename(filePath)}` }),
          },
        ];
      }),
    );

    return c.json({ ...summary, parts });
  });

  app.post('/projects/:id/scenes/:sceneId/acknowledge', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const scene = toSceneId(c.req.param('sceneId') ?? '');
    const cleared = project.acknowledgeScene(scene);
    await ctx.repo.save(project);
    return c.json({ cleared, scene: project.sceneSummary(scene) ?? null });
  });

  // Editor: manual reorder/exclude for the assembled cut — a user-authored
  // override of the auto-assembled sequence (see Project.trimTimeline).
  app.post('/projects/:id/timeline/trim', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ order?: string[] }>();
    if (!Array.isArray(body.order)) return c.json({ error: 'order must be an array of scene ids' }, 400);

    let report;
    try {
      report = project.trimTimeline(body.order.map((id) => toSceneId(id)));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    await ctx.repo.save(project);
    return c.json({ report, overview: project.overview() });
  });

  // Editor: reverts a trim back to auto-assembly.
  app.post('/projects/:id/timeline/reset', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const report = project.resetTimeline();
    await ctx.repo.save(project);
    return c.json({ report, overview: project.overview() });
  });

  app.post('/projects/:id/lifecycle', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ lifecycle?: ProjectLifecycle }>();
    if (!body.lifecycle) return c.json({ error: 'lifecycle is required' }, 400);

    project.lifecycle = body.lifecycle;
    await ctx.repo.save(project);
    return c.json(project.overview());
  });

  // Director: the creative brief everything else reads. No graph dependency to
  // supply the idea (style is a root node), so it's captured in a per-request Agent.
  app.post('/projects/:id/style/generate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ idea?: string }>();
    if (!body.idea) return c.json({ error: 'idea is required' }, 400);

    project.idea = body.idea;
    const report = await runNode(project, STYLE_NODE, {
      style: createDirectorAgent(ctx.textAdapter, body.idea, ctx.craftMemory.forRole('Director').map((l) => l.body)),
    });
    await ctx.repo.save(project);
    const style = project.graph.get(STYLE_NODE)?.current?.payload as StylePayload | undefined;
    return c.json({ report, style, overview: project.overview() });
  });

  // Researcher: Parallel Search over the idea. Findings are returned, not
  // persisted — the orchestrator (or the wizard) passes them straight into
  // /script/generate as the `research` field.
  app.post('/projects/:id/research/generate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ idea?: string }>();
    if (!body.idea) return c.json({ error: 'idea is required' }, 400);

    const style = project.graph.get(STYLE_NODE)?.current?.payload as StylePayload | undefined;
    const research = await runResearch(ctx.researchAdapter, body.idea, style);
    return c.json(research);
  });

  // Writer: idea + current style brief -> full script text, in the guided wizard.
  // Not committed here — the caller shows it for review/editing and commits via the
  // existing POST /projects/:id/script (same as pasting a script by hand). An
  // optional `research` payload (from /research/generate) grounds the draft.
  app.post('/projects/:id/script/generate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{ idea?: string; research?: ResearchResult }>();
    if (!body.idea) return c.json({ error: 'idea is required' }, 400);

    const style = project.graph.get(STYLE_NODE)?.current?.payload as StylePayload | undefined;
    const writerNotes = project.openNotesFor('Writer');
    const script = await generateWriterScript(
      ctx.textAdapter,
      body.idea,
      style,
      body.research,
      writerNotes,
      ctx.craftMemory.forRole('Writer').map((l) => l.body),
    );
    // The draft isn't committed here (see POST /script), so the Writer's notes
    // are marked addressed when the caller commits — for now note that they fed in.
    return c.json({ script, addressedNotes: writerNotes.map((n) => n.id) });
  });

  // Cinematographer: shot type/framing/camera move for one scene, reading that
  // scene's text and the style brief (already wired as its graph dependencies),
  // plus any open crew notes for this scene — which it marks addressed on success.
  app.post('/projects/:id/scenes/:sceneId/plan/generate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const scene = toSceneId(c.req.param('sceneId') ?? '');
    const nodeId = scenePartNode(scene, 'plan');
    if (!project.graph.has(nodeId)) return c.json({ error: `No such scene node "${nodeId}"` }, 404);

    const notes = project.openNotesFor('Cinematographer', scene);
    const report = await runNode(project, nodeId, {
      scenePlan: createCinematographerAgent(ctx.textAdapter, notes, ctx.craftMemory.forRole('Cinematographer').map((l) => l.body)),
    });
    if (notes.length > 0) {
      project.addressNotes(notes.map((n) => n.id), project.graph.get(nodeId)?.current?.id);
    }
    await ctx.repo.save(project);
    return c.json({ report, scene: project.sceneSummary(scene), addressedNotes: notes.map((n) => n.id) });
  });

  // Composer: musical direction for the score, reading the style brief (already
  // wired as MUSIC_NODE's graph dependency) + open crew notes for the Composer.
  app.post('/projects/:id/music/generate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const notes = project.openNotesFor('Composer');
    const report = await runNode(project, MUSIC_NODE, {
      music: createComposerAgent(ctx.textAdapter, notes, ctx.craftMemory.forRole('Composer').map((l) => l.body)),
    });
    if (notes.length > 0) {
      project.addressNotes(notes.map((n) => n.id), project.graph.get(MUSIC_NODE)?.current?.id);
    }
    await ctx.repo.save(project);
    const music = project.graph.get(MUSIC_NODE)?.current?.payload;
    return c.json({ report, music, overview: project.overview(), addressedNotes: notes.map((n) => n.id) });
  });

  // Layer 2 — Dailies. The Director reviews the produced cut and dictates notes.
  app.post('/projects/:id/dailies', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    if (project.sceneIds.length === 0) return c.json({ error: 'No scenes to review yet' }, 409);

    const { verdicts, notes } = await runDailies(ctx.textAdapter, crewContext(project));
    const saved = persistNotes(project, notes);
    await ctx.repo.save(project);
    return c.json({ verdicts, notes: saved, overview: project.overview() });
  });

  // Layer 3 — Production meeting. All five personas discuss the cut; the notes
  // they agree on are persisted, the transcript is returned for display.
  app.post('/projects/:id/meeting', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    if (project.sceneIds.length === 0) return c.json({ error: 'No scenes to discuss yet' }, 409);

    const { transcript, notes } = await runProductionMeeting(ctx.textAdapter, crewContext(project));
    const saved = persistNotes(project, notes);
    await ctx.repo.save(project);
    return c.json({ transcript, notes: saved, overview: project.overview() });
  });

  // Every note, open and addressed — the coordination log.
  app.get('/projects/:id/notes', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    return c.json({ notes: project.notes });
  });

  // Layer 4 — a scene huddle. On-demand: the five personas talk one scene
  // through; entries persist to the project, lessons persist cross-project.
  // Observational — no notes, no jobs.
  app.post('/projects/:id/scenes/:sceneId/deliberate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    const scene = toSceneId(c.req.param('sceneId') ?? '');
    const textNode = project.graph.get(scenePartNode(scene, 'text'));
    if (!textNode) return c.json({ error: `No such scene "${scene}"` }, 404);
    if (!textNode.current) return c.json({ error: 'Scene has no committed text to discuss yet' }, 409);

    const out = await deliberateScene(ctx, project, scene);
    await ctx.repo.save(project);
    return c.json(out);
  });

  // Every scene, one huddle each, in order.
  app.post('/projects/:id/deliberate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    if (project.sceneIds.length === 0) return c.json({ error: 'No scenes to discuss yet' }, 409);

    const scenes: Array<{ sceneId: string } & Awaited<ReturnType<typeof deliberateScene>>> = [];
    for (const scene of project.sceneIds) {
      if (!project.graph.get(scenePartNode(scene, 'text'))?.current) continue;
      scenes.push({ sceneId: String(scene), ...(await deliberateScene(ctx, project, scene)) });
    }
    await ctx.repo.save(project);
    return c.json({ scenes });
  });

  // The Rooms tab: every entry + every craft lesson.
  app.get('/projects/:id/rooms', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);
    return c.json({ entries: project.rooms, learnings: ctx.craftMemory.all() });
  });

  // Composer, second act: render the committed music brief into an actual
  // soundtrack clip (Lyria). Synchronous and single-shot — the adapter is
  // timeout-bounded and this never loops. 409 if there's no brief to render yet.
  app.post('/projects/:id/music/render', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const brief = project.graph.get(MUSIC_NODE)?.current?.payload as MusicPayload | undefined;
    if (!brief || brief.genre === 'none') {
      return c.json({ error: 'Generate the music brief before rendering a track' }, 409);
    }

    const { filePath, model } = await renderMusicTrack(ctx.musicAdapter, brief);
    project.recordGeneration(
      MUSIC_NODE,
      { ...brief, trackFile: basename(filePath) } satisfies MusicPayload,
      { prompt: `${brief.genre}, ${brief.instrumentation}, ${brief.tempo}, ${brief.mood}`, model },
    );
    await ctx.repo.save(project);

    const music = project.graph.get(MUSIC_NODE)?.current?.payload as MusicPayload;
    return c.json({ music, trackUrl: `/media/${basename(filePath)}`, overview: project.overview() });
  });

  app.post('/projects/:id/scenes/:sceneId/generate', async (c) => {
    const project = await loadProject(c, ctx);
    if (!project) return notFound(c);

    const body = await c.req.json<{
      part?: GeneratablePart;
      prompt?: string;
      seed?: number;
      priority?: number;
      maxAttempts?: number;
    }>();

    if (!body.part || !(body.part in PART_TO_CAPABILITY)) {
      return c.json({ error: `part must be one of: ${Object.keys(PART_TO_CAPABILITY).join(', ')}` }, 400);
    }
    if (!body.prompt) return c.json({ error: 'prompt is required' }, 400);

    const scene = toSceneId(c.req.param('sceneId') ?? '');
    const nodeId = scenePartNode(scene, body.part);
    if (!project.graph.has(nodeId)) return c.json({ error: `No such scene node "${nodeId}"` }, 404);

    // Ken Burns video is generated *from* the scene image, not from the prompt alone —
    // app-layer knowledge, same reasoning as PART_TO_CAPABILITY above.
    let params: Record<string, unknown> | undefined;
    if (body.part === 'video') {
      const imageNode = project.graph.get(scenePartNode(scene, 'image'));
      const imagePath = (imageNode?.current?.payload as { filePath?: string } | undefined)?.filePath;
      if (!imagePath) return c.json({ error: 'Generate the scene image before the video' }, 400);
      params = { imagePath };
    }

    // The Cinematographer's plan is what the image model actually gets prompted
    // from, once one exists — the cheap system seed has no shotType/framing/
    // cameraMove, so this only kicks in after a real plan/generate call.
    let prompt = body.prompt;
    let seed = body.seed;
    if (body.part === 'image') {
      const style = project.graph.get(STYLE_NODE)?.current?.payload as StylePayload | undefined;
      const planNode = project.graph.get(scenePartNode(scene, 'plan'));
      const plan = planNode?.current?.payload as ScenePlanPayload | undefined;
      const cinematography = [plan?.shotType, plan?.framing, plan?.cameraMove].filter(Boolean).join(', ');
      // Prepend the Director's visual-continuity note + a stable per-project seed so
      // every scene renders the same character, place, and film look.
      prompt = [
        style?.visualAnchor && `Visual continuity — hold consistent across every scene: ${style.visualAnchor}`,
        cinematography && `${cinematography}.`,
        body.prompt,
      ]
        .filter(Boolean)
        .join('\n');
      if (seed === undefined) seed = stableSeed(String(project.id));
    }

    const job = await ctx.queue.enqueue({
      projectId: project.id,
      nodeId,
      kind: PART_TO_CAPABILITY[body.part],
      payload: {
        prompt,
        ...(seed !== undefined && { seed }),
        ...(params && { params }),
      },
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.maxAttempts !== undefined && { maxAttempts: body.maxAttempts }),
    });
    return c.json(job, 201);
  });

  app.get('/projects/:id/jobs', async (c) => {
    const id = projectId(c.req.param('id') ?? '');
    return c.json(await ctx.jobStore.list({ projectId: id }));
  });

  app.post('/projects/:id/jobs/cancel', async (c) => {
    const id = projectId(c.req.param('id') ?? '');
    const cancelled = await ctx.jobStore.cancelByProject(id, ctx.rt.clock.now());
    return c.json({ cancelled });
  });

  // Deon's primary screen (F9): every project's job status, at a glance, in one call.
  app.get('/jobs', async (c) => {
    return c.json(await ctx.jobStore.summary());
  });

  // Serves generated images/video. Filenames are always adapter-generated UUIDs
  // (see @osai/inference) with no path separators, but reject traversal defensively.
  app.get('/media/:filename', async (c) => {
    const filename = c.req.param('filename');
    if (!filename || filename.includes('/') || filename.includes('..')) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const ext = filename.split('.').pop() ?? '';
    try {
      const data = await readFile(join(ctx.mediaDir, filename));
      return new Response(data, { headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' } });
    } catch {
      return notFound(c);
    }
  });

  // apps/web calls the API under `/api` (see web/src/lib/api.ts BASE); the test
  // suite and the ADK client use the bare paths. Same handlers, mounted at both.
  const root = new Hono();
  root.route('/api', app);
  root.route('/', app);

  // Production: serve the built React app when the image sets OSAI_WEB_DIR.
  // SPA fallback so /studio, deep links, and hard refreshes resolve to index.html.
  if (ctx.webDir) {
    root.use('/*', serveStatic({ root: ctx.webDir }));
    root.get('/*', serveStatic({ path: 'index.html', root: ctx.webDir }));
  }

  return root;
}

async function loadProject(c: Context, ctx: AppContext): Promise<Project | undefined> {
  return ctx.repo.load(projectId(c.req.param('id') ?? ''));
}

function notFound(c: Context): Response {
  return c.json({ error: 'project not found' }, 404);
}
