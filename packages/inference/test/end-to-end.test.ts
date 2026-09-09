import { Project, projectId, scenePartNode, testRuntime, type ProjectId } from '@osai/core';
import { InMemoryNotificationSink, JobQueue, SqliteJobStore } from '@osai/jobs';
import { describe, expect, it } from 'vitest';

import { createFakeAdapterRegistry, InferenceError } from '../src/adapter.js';
import { createInferenceExecutor, type ProjectLookup } from '../src/executor.js';

class MapProjectLookup implements ProjectLookup {
  private readonly projects = new Map<ProjectId, Project>();
  register(project: Project): void {
    this.projects.set(project.id, project);
  }
  async get(id: ProjectId): Promise<Project | undefined> {
    return this.projects.get(id);
  }
  async save(project: Project): Promise<void> {
    this.projects.set(project.id, project);
  }
}

function buildProject(rt = testRuntime()) {
  const project = new Project({ id: projectId('p1'), title: 'Barns explained', lifecycle: 'active' }, rt);
  project.initializeFromScript([{ text: 'A scene about barns.' }, { text: 'A scene about silos.' }]);
  return project;
}

/**
 * The full seam this phase exists to complete: enqueue → JobQueue claims → this
 * package's executor calls an adapter → the result lands on Project via
 * `recordGeneration`, exactly as if a caller had invoked it directly.
 */
describe('end to end: JobQueue → inference executor → Project', () => {
  it('runs a queued image job through to a recorded, retrievable version', async () => {
    const rt = testRuntime();
    const project = buildProject(rt);
    const scene1 = project.sceneIds[0]!;
    const imageNode = scenePartNode(scene1, 'image');

    const lookup = new MapProjectLookup();
    lookup.register(project);
    const notify = new InMemoryNotificationSink();
    const store = new SqliteJobStore();
    const executor = createInferenceExecutor(createFakeAdapterRegistry(), lookup);
    const queue = new JobQueue(store, rt, { executor, notify });

    const enqueued = await queue.enqueue({
      projectId: project.id,
      nodeId: imageNode,
      kind: 'image',
      payload: { prompt: 'wide shot of a red barn' },
    });

    const claimed = await queue.tick();
    expect(claimed?.id).toBe(enqueued.id);

    const finalJob = await store.get(enqueued.id);
    expect(finalJob?.status).toBe('succeeded');

    const node = project.graph.require(imageNode);
    expect(node.versionCount).toBe(1);
    expect(node.requireCurrent().payload).toMatchObject({
      capability: 'image',
      prompt: 'wide shot of a red barn',
    });

    expect(notify.sent).toEqual([{ type: 'succeeded', job: finalJob }]);
  });

  it('generating a scene image flags only that node — the graph stays precise even reached through the queue', async () => {
    const rt = testRuntime();
    const project = buildProject(rt);
    const scene1 = project.sceneIds[0]!;

    const lookup = new MapProjectLookup();
    lookup.register(project);
    const store = new SqliteJobStore();
    const executor = createInferenceExecutor(createFakeAdapterRegistry(), lookup);
    const queue = new JobQueue(store, rt, { executor });

    await queue.enqueue({
      projectId: project.id,
      nodeId: scenePartNode(scene1, 'image'),
      kind: 'image',
      payload: { prompt: 'scene one' },
    });
    await queue.tick();

    // The freshly generated node is now awaiting review — and ONLY it. No
    // sibling scene, no upstream node, gets dragged in.
    expect(project.overview().needsAttention).toEqual([scenePartNode(scene1, 'image')]);
    expect(project.graph.require(scenePartNode(scene1, 'image')).status).toBe('needsReview');
  });

  it('a retryable adapter failure requeues the job without touching the project', async () => {
    const rt = testRuntime();
    const project = buildProject(rt);
    const scene1 = project.sceneIds[0]!;
    const imageNode = scenePartNode(scene1, 'image');

    const lookup = new MapProjectLookup();
    lookup.register(project);
    const store = new SqliteJobStore();
    const adapters = createFakeAdapterRegistry({
      image: {
        respond: async () => {
          throw new InferenceError({ code: 'RATE_LIMIT', message: 'busy', retryable: true });
        },
      },
    });
    const executor = createInferenceExecutor(adapters, lookup);
    const queue = new JobQueue(store, rt, { executor });

    const enqueued = await queue.enqueue({
      projectId: project.id,
      nodeId: imageNode,
      kind: 'image',
      payload: { prompt: 'wide shot' },
      maxAttempts: 3,
    });
    await queue.tick();

    const afterFirstAttempt = await store.get(enqueued.id);
    expect(afterFirstAttempt?.status).toBe('queued');
    expect(afterFirstAttempt?.attempt).toBe(1);
    expect(project.graph.require(imageNode).hasVersions).toBe(false);
  });
});
