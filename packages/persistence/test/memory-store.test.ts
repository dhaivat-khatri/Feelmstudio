import { projectId } from '@osai/core';
import { describe, expect, it } from 'vitest';

import { InMemoryProjectStore } from '../src/memory-store.js';
import { buildProject, generateAllMedia } from './helpers.js';

describe('InMemoryProjectStore', () => {
  it('returns undefined for a project that was never saved', async () => {
    const store = new InMemoryProjectStore();
    await expect(store.load(projectId('missing'))).resolves.toBeUndefined();
  });

  it('round-trips a saved snapshot exactly', async () => {
    const store = new InMemoryProjectStore();
    const project = buildProject();
    generateAllMedia(project);

    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');
    const loaded = await store.load(project.id);

    expect(loaded).toEqual(project.toSnapshot());
  });

  it('lists saved projects with summary metadata', async () => {
    const store = new InMemoryProjectStore();
    const project = buildProject();
    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    await expect(store.list()).resolves.toEqual([
      {
        id: project.id,
        title: project.title,
        lifecycle: project.lifecycle,
        savedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('deletes a project', async () => {
    const store = new InMemoryProjectStore();
    const project = buildProject();
    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    await store.delete(project.id);

    await expect(store.load(project.id)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('is not aliased to the caller — mutating the saved or loaded snapshot never leaks', async () => {
    const store = new InMemoryProjectStore();
    const project = buildProject();
    const snapshot = project.toSnapshot();

    await store.save(snapshot, '2026-01-01T00:00:00.000Z');
    (snapshot as { title: string }).title = 'tampered after save';

    const loaded = await store.load(project.id);
    expect(loaded?.title).toBe(project.title);

    (loaded as { title: string }).title = 'tampered after load';
    const loadedAgain = await store.load(project.id);
    expect(loadedAgain?.title).toBe(project.title);
  });

  it('overwrites on a second save to the same id', async () => {
    const store = new InMemoryProjectStore();
    const project = buildProject();
    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    project.title = 'Renamed';
    await store.save(project.toSnapshot(), '2026-01-02T00:00:00.000Z');

    await expect(store.list()).resolves.toHaveLength(1);
    const loaded = await store.load(project.id);
    expect(loaded?.title).toBe('Renamed');
  });
});
