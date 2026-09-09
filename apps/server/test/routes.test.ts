import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testRuntime } from '@osai/core';
import { createFakeAdapterRegistry } from '@osai/inference';

import { createInMemoryCraftMemoryStore } from '../src/craft-memory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContext, type AppContext } from '../src/context.js';
import { createApp } from '../src/routes.js';

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osai-server-'));
  // ':memory:' for the job store, testRuntime for determinism, fake adapters so
  // this stays fast and offline — real mflux/ffmpeg generation is smoke-tested
  // manually (see @osai/inference's README), not exercised here.
  ctx = createContext({
    rt: testRuntime(),
    jobsDbPath: ':memory:',
    projectsDir: dir,
    adapters: createFakeAdapterRegistry(),
    // Fake Parallel adapter — deterministic findings, no network.
    researchAdapter: {
      research: async (q: string) => ({
        findings: [`fact for: ${q}`],
        sources: [{ title: 'Source A', url: 'https://example.com/a' }],
      }),
    },
  });
  app = createApp(ctx);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** `Response.json()` is typed `Promise<unknown>` under Node's fetch types — this is the one place that trusts the shape. */
async function readJson<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('POST /projects', () => {
  it('creates a project', async () => {
    const res = await app.request('/projects', post({ title: 'Compound interest, explained' }));
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.title).toBe('Compound interest, explained');
    expect(body.lifecycle).toBe('draft');
  });

  it('rejects a missing title', async () => {
    const res = await app.request('/projects', post({}));
    expect(res.status).toBe(400);
  });
});

describe('GET /projects and /projects/:id', () => {
  it('lists created projects and fetches one by id', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'A' })));

    const list = await readJson<Record<string, any>[]>(await app.request('/projects'));
    expect(list).toEqual([expect.objectContaining({ id: created.projectId, title: 'A' })]);

    const fetched = await readJson(await app.request(`/projects/${created.projectId}`));
    expect(fetched.projectId).toBe(created.projectId);
  });

  it('404s for an unknown project', async () => {
    const res = await app.request('/projects/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('the full golden path: script → generate → approve', () => {
  it('walks a project from paste-script through a recorded generation to approval', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'Barns' })));
    const projectId = created.projectId as string;

    // 1. Paste script — first segmentation applies directly.
    const scriptRes = await app.request(
      `/projects/${projectId}/script`,
      post({ segments: [{ text: 'A scene about barns.' }, { text: 'A scene about silos.' }] }),
    );
    expect(scriptRes.status).toBe(200);
    const scripted = await readJson(scriptRes);
    expect(scripted.applied).toBe(true);
    expect(scripted.overview.scenes).toHaveLength(2);
    const scene1 = scripted.overview.scenes[0].sceneId as string;

    // 2. Enqueue a generation job for scene 1's image.
    const genRes = await app.request(
      `/projects/${projectId}/scenes/${scene1}/generate`,
      post({ part: 'image', prompt: 'wide shot of a red barn', seed: 7 }),
    );
    expect(genRes.status).toBe(201);
    const job = await readJson(genRes);
    expect(job.status).toBe('queued');

    // 3. Drive the queue by hand (no real-time polling in a test).
    const claimed = await ctx.queue.tick();
    expect(claimed?.id).toBe(job.id);

    // 4. The generation actually landed — the job succeeded, and its result is on
    // the project (recordGeneration adds a version; it doesn't change NodeStatus,
    // which is reserved for explicit setStatus/approve/fail calls).
    const jobsAfter = await readJson<Record<string, any>[]>(
      await app.request(`/projects/${projectId}/jobs`),
    );
    expect(jobsAfter[0]?.status).toBe('succeeded');

    // 5. Approve everything clean.
    const approveRes = await app.request(`/projects/${projectId}/approve-all`, post({}));
    expect(approveRes.status).toBe(200);
    const approved = await readJson(approveRes);
    expect(approved.approved).toBeGreaterThan(0);
  });

  it('rejects generation against a scene that does not exist', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'X' })));
    const projectId = created.projectId as string;
    await app.request(`/projects/${projectId}/script`, post({ segments: [{ text: 'One scene.' }] }));

    const res = await app.request(
      `/projects/${projectId}/scenes/not-a-real-scene/generate`,
      post({ part: 'image', prompt: 'x' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('script edit → segmentation review → apply', () => {
  it('proposes a diff on a second script edit rather than applying it silently', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'Edit flow' })));
    const projectId = created.projectId as string;
    await app.request(
      `/projects/${projectId}/script`,
      post({ segments: [{ text: 'Scene one.' }, { text: 'Scene two.' }, { text: 'Scene three.' }] }),
    );

    // A later edit only proposes — it must not change scene count until applied.
    const editRes = await app.request(
      `/projects/${projectId}/script`,
      post({ segments: [{ text: 'Scene one.' }, { text: 'Scene two, rewritten.' }, { text: 'Scene three.' }] }),
    );
    const edited = await readJson(editRes);
    expect(edited.applied).toBe(false);
    expect(edited.diff).toBeDefined();

    const beforeApply = await readJson(await app.request(`/projects/${projectId}`));
    expect(beforeApply.scenes).toHaveLength(3);

    const applyRes = await app.request(`/projects/${projectId}/segmentation/apply`, post({ diff: edited.diff }));
    expect(applyRes.status).toBe(200);
    const applied = await readJson(applyRes);
    expect(applied.overview.scenes).toHaveLength(3);
  });
});

describe('jobs endpoints', () => {
  it('cancels a project’s queued jobs and reports the count (F11: scrapping is cheap)', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'Scrap me' })));
    const projectId = created.projectId as string;
    await app.request(`/projects/${projectId}/script`, post({ segments: [{ text: 'One scene.' }] }));
    const overview = await readJson(await app.request(`/projects/${projectId}`));
    const scene1 = overview.scenes[0].sceneId as string;

    await app.request(`/projects/${projectId}/scenes/${scene1}/generate`, post({ part: 'image', prompt: 'x' }));

    const cancelRes = await app.request(`/projects/${projectId}/jobs/cancel`, { method: 'POST' });
    const cancelled = await readJson(cancelRes);
    expect(cancelled.cancelled).toBe(1);

    const jobs = await readJson<Record<string, any>[]>(await app.request(`/projects/${projectId}/jobs`));
    expect(jobs[0]?.status).toBe('cancelled');
  });

  it('summarizes jobs across projects for the global Jobs view', async () => {
    const res = await app.request('/jobs');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual([]);
  });
});

describe('POST /projects/:id/research/generate (Researcher — Parallel)', () => {
  it('returns findings + sources for the project idea', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'Lighthouse' })));
    const id = created.projectId as string;

    const res = await app.request(`/projects/${id}/research/generate`, post({ idea: 'a lighthouse keeper on his last night' }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    // runResearch wraps the idea in a search objective — the finding echoes it back.
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toContain('a lighthouse keeper on his last night');
    expect(body.sources).toEqual([{ title: 'Source A', url: 'https://example.com/a' }]);
  });

  it('400s when idea is missing', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'X' })));
    const res = await app.request(`/projects/${created.projectId}/research/generate`, post({}));
    expect(res.status).toBe(400);
  });
});

describe('crew coordination — dailies, meeting, notes', () => {
  const withCrewText = () =>
    createContext({
      rt: testRuntime(),
      jobsDbPath: ':memory:',
      projectsDir: dir,
      adapters: createFakeAdapterRegistry({
        text: {
          respond: (req) => {
            const sp = String(req.params?.systemPrompt ?? '');
            if (sp.includes('dailies')) {
              // Use the real scene id the prompt actually carries, like Gemini would.
              const sceneId = /\[(scene_[0-9a-f]+)\]/.exec(req.prompt)?.[1] ?? null;
              return {
                payload: {
                  verdicts: [{ sceneId, verdict: 'needs work', reasoning: 'too static' }],
                  notes: [
                    { from: 'Director', to: 'Cinematographer', sceneId, body: 'Add an insert of his hands.' },
                    { from: 'Director', to: 'Writer', sceneId: null, body: 'Tighten the ending.' },
                  ],
                },
                model: 'fake',
              };
            }
            if (sp.includes('production-meeting') || sp.includes('production meeting')) {
              return {
                payload: {
                  transcript: [{ speaker: 'Ezra Vantage', role: 'Director', line: 'The middle drags.' }],
                  notes: [{ from: 'Editor', to: 'Composer', sceneId: null, body: 'Cut 4 seconds from the mid-section.' }],
                },
                model: 'fake',
              };
            }
            if (sp.includes('screenwriter')) return { payload: { scenes: ['A quiet scene.'] }, model: 'fake' };
            if (sp.includes('cinematographer'))
              return { payload: { shotType: 'wide', framing: 'centered', cameraMove: 'static', durationSeconds: 5 }, model: 'fake' };
            return { payload: { tone: 't', palette: 'p', pacing: 'e', mood: 'm', genre: 'Drama' }, model: 'fake' };
          },
        },
      }),
    });

  const seedProject = async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'Crew' })));
    const id = created.projectId as string;
    await app.request(`/projects/${id}/script`, post({ segments: [{ text: 'A man waits at a bus stop in the rain.' }] }));
    return id;
  };

  it('dailies stores the Director’s notes and returns verdicts', async () => {
    ctx = withCrewText();
    app = createApp(ctx);
    const id = await seedProject();

    const res = await app.request(`/projects/${id}/dailies`, post({}));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.verdicts[0].verdict).toBe('needs work');
    expect(body.notes).toHaveLength(2);
    expect(body.overview.openNoteCount).toBe(2);
    // the scene-scoped note resolved to a real scene id; the null one stayed whole-project
    const dp = body.notes.find((n: any) => n.to === 'Cinematographer');
    expect(dp.sceneId).not.toBeNull();
    expect(body.notes.find((n: any) => n.to === 'Writer').sceneId).toBeNull();
  });

  it('409s dailies/meeting before there are scenes', async () => {
    ctx = withCrewText();
    app = createApp(ctx);
    const created = await readJson(await app.request('/projects', post({ title: 'Empty' })));
    expect((await app.request(`/projects/${created.projectId}/dailies`, post({}))).status).toBe(409);
    expect((await app.request(`/projects/${created.projectId}/meeting`, post({}))).status).toBe(409);
  });

  it('a Cinematographer replan consumes the open scene note and marks it addressed', async () => {
    ctx = withCrewText();
    app = createApp(ctx);
    const id = await seedProject();
    await app.request(`/projects/${id}/dailies`, post({}));

    const overview = await readJson(await app.request(`/projects/${id}`));
    const sceneId = overview.scenes[0].sceneId as string;

    const replan = await readJson(await app.request(`/projects/${id}/scenes/${sceneId}/plan/generate`, post({})));
    expect(replan.addressedNotes).toHaveLength(1);

    const after = await readJson(await app.request(`/projects/${id}/notes`));
    const dpNote = after.notes.find((n: any) => n.to === 'Cinematographer');
    expect(dpNote.status).toBe('addressed');
    expect(dpNote.addressedByVersion).toBeTruthy();
    // the whole-project Writer note is untouched
    expect(after.notes.find((n: any) => n.to === 'Writer').status).toBe('open');
  });
});

describe('POST /projects/:id/music/render (Composer — Lyria track)', () => {
  const withFakeMusic = () =>
    createContext({
      rt: testRuntime(),
      jobsDbPath: ':memory:',
      projectsDir: dir,
      adapters: createFakeAdapterRegistry({
        text: {
          respond: (req) => {
            const sp = String(req.params?.systemPrompt ?? '');
            if (sp.includes('composer')) {
              return { payload: { genre: 'ambient', instrumentation: 'piano', tempo: 'slow', mood: 'calm' }, model: 'fake' };
            }
            return { payload: { tone: 't', palette: 'p', pacing: 'e', mood: 'm', genre: 'Drama' }, model: 'fake' };
          },
        },
        music: {
          respond: () => ({ payload: { filePath: '/tmp/osai/track-abc.wav', mimeType: 'audio/wav', durationSeconds: 30 }, model: 'fake-lyria' }),
        },
      }),
    });

  it('409s when there is no music brief yet', async () => {
    const created = await readJson(await app.request('/projects', post({ title: 'M' })));
    const res = await app.request(`/projects/${created.projectId}/music/render`, post({}));
    expect(res.status).toBe(409);
  });

  it('renders a track and attaches trackFile to the music node once a brief exists', async () => {
    ctx = withFakeMusic();
    app = createApp(ctx);
    const created = await readJson(await app.request('/projects', post({ title: 'M2' })));
    const id = created.projectId as string;

    await app.request(`/projects/${id}/music/generate`, post({}));
    const res = await app.request(`/projects/${id}/music/render`, post({}));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.trackUrl).toBe('/media/track-abc.wav');
    expect(body.music.trackFile).toBe('track-abc.wav');
    expect(body.music.genre).toBe('ambient'); // brief fields preserved
  });
});

describe('POST /projects/:id/script/generate with research', () => {
  it('feeds provided findings and sources into the Writer prompt', async () => {
    const seenPrompts: string[] = [];
    ctx = createContext({
      rt: testRuntime(),
      jobsDbPath: ':memory:',
      projectsDir: dir,
      adapters: createFakeAdapterRegistry({
        text: {
          respond: (req) => {
            seenPrompts.push(req.prompt);
            return { payload: { scenes: ['A quiet scene.'] }, model: 'fake-text' };
          },
        },
      }),
    });
    app = createApp(ctx);

    const created = await readJson(await app.request('/projects', post({ title: 'Y' })));
    const id = created.projectId as string;
    await app.request(
      `/projects/${id}/script/generate`,
      post({
        idea: 'a lighthouse keeper',
        research: { findings: ['Keepers were automated out in the 1990s.'], sources: [{ title: 'Hist', url: 'https://x/y' }] },
      }),
    );

    expect(seenPrompts.some((p) => p.includes('Keepers were automated out in the 1990s.'))).toBe(true);
    expect(seenPrompts.some((p) => p.includes('https://x/y'))).toBe(true);
  });
});

describe('static web serving (Cloud Run: one container, API + SPA)', () => {
  it('serves the API under /api too — the web client uses that prefix', async () => {
    const res = await app.request('/api/projects', post({ title: 'via /api' }));
    expect(res.status).toBe(201);
    expect((await readJson(res)).title).toBe('via /api');
  });

  it('falls back to index.html for an unknown non-API path when webDir is set', async () => {
    const webDir = await mkdtemp(join(tmpdir(), 'osai-web-'));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>OSAI Studio</title>');
    const localApp = createApp(
      createContext({
        rt: testRuntime(),
        jobsDbPath: ':memory:',
        projectsDir: dir,
        adapters: createFakeAdapterRegistry(),
        webDir,
      }),
    );

    const res = await localApp.request('/studio');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('OSAI Studio');

    await rm(webDir, { recursive: true, force: true });
  });
});

describe('agent rooms — deliberation + craft memory', () => {
  const craft = createInMemoryCraftMemoryStore();
  const withDeliberation = () =>
    createContext({
      rt: testRuntime(),
      jobsDbPath: ':memory:',
      projectsDir: dir,
      craftMemory: craft,
      adapters: createFakeAdapterRegistry({
        text: {
          respond: (req) => {
            const sp = String(req.params?.systemPrompt ?? '');
            if (sp.includes('scene huddle')) {
              return {
                payload: {
                  entries: [
                    { author: 'Cinematographer', kind: 'think', to: null, replyTo: null, body: 'The frame is too clean for this mood.' },
                    { author: 'Cinematographer', kind: 'ask', to: 'Composer', replyTo: null, body: 'Can the score carry the dread instead?' },
                    { author: 'Composer', kind: 'reply', to: 'Cinematographer', replyTo: 1, body: 'Yes — low drone under the whole shot.' },
                  ],
                  learnings: [{ role: 'Cinematographer', body: 'A clean frame can undercut dread; let sound do the work.' }],
                },
                model: 'fake',
              };
            }
            if (sp.includes('screenwriter')) return { payload: { scenes: ['A quiet scene.'] }, model: 'fake' };
            return { payload: { tone: 't', palette: 'p', pacing: 'e', mood: 'm', genre: 'Drama' }, model: 'fake' };
          },
        },
      }),
    });

  const seed = async () => {
    ctx = withDeliberation();
    app = createApp(ctx);
    const created = await readJson(await app.request('/projects', post({ title: 'Rooms' })));
    const id = created.projectId as string;
    await app.request(`/projects/${id}/script`, post({ segments: [{ text: 'A diver sinks past a drowned reading room.' }] }));
    return id;
  };

  it('deliberating a scene persists room entries and a learning', async () => {
    const id = await seed();
    const sceneId = (await readJson(await app.request(`/projects/${id}`))).scenes[0].sceneId as string;

    const res = await app.request(`/projects/${id}/scenes/${sceneId}/deliberate`, post({}));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.entries).toHaveLength(3);
    expect(body.entries[2].replyTo).toBe(body.entries[1].id); // reply linked to the ask
    expect(body.learnings[0].role).toBe('Cinematographer');

    const rooms = await readJson(await app.request(`/projects/${id}/rooms`));
    expect(rooms.entries).toHaveLength(3);
    expect(rooms.learnings.Cinematographer).toHaveLength(1);
  });

  it('404s a scene that does not exist', async () => {
    ctx = withDeliberation();
    app = createApp(ctx);
    const created = await readJson(await app.request('/projects', post({ title: 'Empty' })));
    const res = await app.request(`/projects/${created.projectId}/scenes/scene_missing/deliberate`, post({}));
    expect(res.status).toBe(404);
  });

  it('a carried learning reaches the Writer prompt on the next script generation', async () => {
    const id = await seed();
    const sceneId = (await readJson(await app.request(`/projects/${id}`))).scenes[0].sceneId as string;
    await app.request(`/projects/${id}/scenes/${sceneId}/deliberate`, post({}));
    craft.add([{ role: 'Writer', body: 'Open on motion, not exposition.', sourceProjectId: id, sourceSceneId: sceneId }]);

    let seenPrompt = '';
    ctx = createContext({
      rt: testRuntime(),
      jobsDbPath: ':memory:',
      projectsDir: dir,
      craftMemory: craft,
      adapters: createFakeAdapterRegistry({
        text: {
          respond: (req) => {
            seenPrompt += req.prompt;
            return { payload: { scenes: ['A scene.'] }, model: 'fake' };
          },
        },
      }),
    });
    app = createApp(ctx);
    await app.request(`/projects/${id}/script/generate`, post({ idea: 'a diver explores a sunken library' }));
    expect(seenPrompt).toContain('Open on motion, not exposition.');
  });
});
