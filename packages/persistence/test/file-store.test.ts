import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectId } from '@osai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileProjectStore } from '../src/file-store.js';
import { buildProject, generateAllMedia } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osai-persistence-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileProjectStore', () => {
  it('returns undefined for a project that was never saved, without the directory existing yet', async () => {
    const store = new FileProjectStore(join(dir, 'does-not-exist-yet'));
    await expect(store.load(projectId('missing'))).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('survives a restart: a fresh store instance over the same directory reads what was saved', async () => {
    const project = buildProject();
    generateAllMedia(project);

    const writer = new FileProjectStore(dir);
    await writer.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    const reader = new FileProjectStore(dir);
    const loaded = await reader.load(project.id);

    expect(loaded).toEqual(project.toSnapshot());
  });

  it('writes via a temp file and leaves no temp files behind on success', async () => {
    const store = new FileProjectStore(dir);
    const project = buildProject();
    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    const entries = await readdir(dir);
    expect(entries).toEqual([`${project.id}.json`]);
  });

  it('lists saved projects with summary metadata', async () => {
    const store = new FileProjectStore(dir);
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

  it('deletes a project file', async () => {
    const store = new FileProjectStore(dir);
    const project = buildProject();
    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    await store.delete(project.id);

    await expect(store.load(project.id)).resolves.toBeUndefined();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('deleting a project that was never saved does not throw', async () => {
    const store = new FileProjectStore(dir);
    await expect(store.delete(projectId('never-existed'))).resolves.toBeUndefined();
  });

  it('overwrites on a second save to the same id, atomically', async () => {
    const store = new FileProjectStore(dir);
    const project = buildProject();
    await store.save(project.toSnapshot(), '2026-01-01T00:00:00.000Z');

    project.title = 'Renamed';
    await store.save(project.toSnapshot(), '2026-01-02T00:00:00.000Z');

    const raw = await readFile(join(dir, `${project.id}.json`), 'utf8');
    expect(JSON.parse(raw).snapshot.title).toBe('Renamed');
    expect(await readdir(dir)).toEqual([`${project.id}.json`]);
  });
});
