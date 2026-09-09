import {
  Project,
  nodeId,
  projectId,
  testRuntime,
  type NodeId,
  type ProjectId,
} from '@osai/core';
import type { Job } from '@osai/jobs';
import { describe, expect, it } from 'vitest';

import { createFakeAdapterRegistry, InferenceError } from '../src/adapter.js';
import { createInferenceExecutor, type ProjectLookup } from '../src/executor.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'job_1',
    projectId: projectId('p1'),
    nodeId: nodeId('n1'),
    kind: 'image',
    payload: { prompt: 'a red barn' },
    status: 'running',
    priority: 0,
    attempt: 0,
    maxAttempts: 1,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

/** A ProjectLookup over a plain in-memory map, standing in for a real repository. */
class MapProjectLookup implements ProjectLookup {
  private readonly projects = new Map<ProjectId, Project>();
  readonly savedIds: ProjectId[] = [];

  register(project: Project): void {
    this.projects.set(project.id, project);
  }

  async get(id: ProjectId): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async save(project: Project): Promise<void> {
    this.projects.set(project.id, project);
    this.savedIds.push(project.id);
  }
}

function buildProjectWithImageNode(): { project: Project; imageNode: NodeId } {
  const project = new Project({ id: projectId('p1'), title: 'Test', lifecycle: 'active' }, testRuntime());
  project.initializeFromScript([{ text: 'A scene about barns.' }]);
  const scene = project.sceneIds[0]!;
  const imageNode = nodeId(`${scene}:image`);
  return { project, imageNode };
}

describe('createInferenceExecutor', () => {
  it('records a successful generation onto the project and saves it', async () => {
    const { project, imageNode } = buildProjectWithImageNode();
    const lookup = new MapProjectLookup();
    lookup.register(project);

    const executor = createInferenceExecutor(createFakeAdapterRegistry(), lookup);
    const result = await executor(
      makeJob({ projectId: project.id, nodeId: imageNode, kind: 'image', payload: { prompt: 'a red barn', seed: 3 } }),
    );

    expect(result).toEqual({ ok: true });
    const node = project.graph.require(imageNode);
    expect(node.versionCount).toBe(1);
    expect(node.requireCurrent().provenance).toMatchObject({ prompt: 'a red barn', seed: 3, model: 'fake-image' });
    expect(lookup.savedIds).toEqual([project.id]);
  });

  it('fails with a non-retryable error for an unknown capability, and marks the node failed', async () => {
    const { project, imageNode } = buildProjectWithImageNode();
    const lookup = new MapProjectLookup();
    lookup.register(project);

    const executor = createInferenceExecutor(createFakeAdapterRegistry(), lookup);
    const result = await executor(makeJob({ projectId: project.id, nodeId: imageNode, kind: 'sculpture' }));

    expect(result).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_CAPABILITY', message: 'No adapter for "sculpture"', retryable: false },
    });
    const node = project.graph.require(imageNode);
    expect(node.status).toBe('failed');
    expect(node.failure).toMatchObject({ code: 'UNKNOWN_CAPABILITY' });
    expect(lookup.savedIds).toEqual([project.id]);
  });

  it('fails with a non-retryable error when the payload has no prompt, and marks the node failed', async () => {
    const { project, imageNode } = buildProjectWithImageNode();
    const lookup = new MapProjectLookup();
    lookup.register(project);

    const executor = createInferenceExecutor(createFakeAdapterRegistry(), lookup);
    const result = await executor(
      makeJob({ projectId: project.id, nodeId: imageNode, kind: 'image', payload: { seed: 1 } }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD', retryable: false } });
    expect(project.graph.require(imageNode).status).toBe('failed');
  });

  it('fails with a non-retryable error when the project cannot be found', async () => {
    const lookup = new MapProjectLookup();
    const executor = createInferenceExecutor(createFakeAdapterRegistry(), lookup);

    const result = await executor(makeJob({ projectId: projectId('missing') }));

    expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_FOUND', retryable: false } });
  });

  it('propagates an adapter InferenceError, including its retryable flag, and marks the node failed', async () => {
    const { project, imageNode } = buildProjectWithImageNode();
    const lookup = new MapProjectLookup();
    lookup.register(project);

    const adapters = createFakeAdapterRegistry({
      image: {
        respond: async () => {
          throw new InferenceError({ code: 'RATE_LIMIT', message: 'slow down', retryable: true });
        },
      },
    });
    const executor = createInferenceExecutor(adapters, lookup);
    const result = await executor(makeJob({ projectId: project.id, nodeId: imageNode, kind: 'image' }));

    expect(result).toEqual({
      ok: false,
      error: { code: 'RATE_LIMIT', message: 'slow down', retryable: true },
    });
    const node = project.graph.require(imageNode);
    expect(node.status).toBe('failed');
    expect(node.failure).toMatchObject({ code: 'RATE_LIMIT', message: 'slow down', retryable: true });
    expect(lookup.savedIds).toEqual([project.id]);
  });

  it('wraps a plain thrown Error as a non-retryable JobError', async () => {
    const { project, imageNode } = buildProjectWithImageNode();
    const lookup = new MapProjectLookup();
    lookup.register(project);

    const adapters = createFakeAdapterRegistry({
      image: {
        respond: async () => {
          throw new Error('boom');
        },
      },
    });
    const executor = createInferenceExecutor(adapters, lookup);
    const result = await executor(makeJob({ projectId: project.id, nodeId: imageNode, kind: 'image' }));

    expect(result).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_ERROR', message: 'boom', retryable: false },
    });
  });
});
