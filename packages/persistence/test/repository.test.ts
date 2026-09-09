import { projectId, scenePartNode, testRuntime, type SceneId } from '@osai/core';
import { describe, expect, it } from 'vitest';

import { InMemoryProjectStore } from '../src/memory-store.js';
import { ProjectRepository } from '../src/repository.js';
import { buildProject, generateAllMedia } from './helpers.js';

describe('ProjectRepository', () => {
  it('returns undefined for a project that was never saved', async () => {
    const repo = new ProjectRepository(new InMemoryProjectStore(), testRuntime());
    await expect(repo.load(projectId('missing'))).resolves.toBeUndefined();
  });

  it('saves and reloads a Project with equivalent state', async () => {
    const store = new InMemoryProjectStore();
    const repo = new ProjectRepository(store, testRuntime());

    const project = buildProject();
    generateAllMedia(project);
    project.approveAll();

    await repo.save(project);
    const reloaded = await repo.load(project.id);

    expect(reloaded).toBeDefined();
    expect(reloaded?.overview()).toEqual(project.overview());
    expect(reloaded?.segmentation).toEqual(project.segmentation);
  });

  it('a reloaded project keeps working — regeneration and staleness behave exactly as if the process had never restarted', async () => {
    const store = new InMemoryProjectStore();
    const repo = new ProjectRepository(store, testRuntime());

    const project = buildProject();
    generateAllMedia(project);
    project.approveAll();
    await repo.save(project);

    const reloaded = await repo.load(project.id);
    expect(reloaded).toBeDefined();
    const restored = reloaded as NonNullable<typeof reloaded>;

    const s1 = restored.sceneIds[0] as SceneId;
    restored.recordGeneration(scenePartNode(s1, 'image'), 'reroll.png', { seed: 42 });

    const image = restored.graph.require(scenePartNode(s1, 'image'));
    expect(image.versionCount).toBe(2);
    expect(image.requireCurrent().payload).toBe('reroll.png');
    expect(image.isStale).toBe(false);
  });

  it('lists and deletes through the same repository', async () => {
    const store = new InMemoryProjectStore();
    const repo = new ProjectRepository(store, testRuntime());
    const project = buildProject();

    await repo.save(project);
    await expect(repo.list()).resolves.toEqual([
      expect.objectContaining({ id: project.id, title: project.title }),
    ]);

    await repo.delete(project.id);
    await expect(repo.load(project.id)).resolves.toBeUndefined();
    await expect(repo.list()).resolves.toEqual([]);
  });
});
