import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCraftMemoryStore } from '../src/craft-memory.js';

let dir: string;
let file: string;
let seq: number;
const opts = () => ({ filePath: file, now: () => '2026-09-08T00:00:00.000Z', nextId: () => `learn_${++seq}` });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'craft-'));
  file = join(dir, 'craft-memory.json');
  seq = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CraftMemoryStore', () => {
  it('adds learnings and returns a role newest-first, honouring the limit', () => {
    const store = createCraftMemoryStore(opts());
    store.add([
      { role: 'Writer', body: 'first', sourceProjectId: 'p1', sourceSceneId: 's1' },
      { role: 'Writer', body: 'second', sourceProjectId: 'p1', sourceSceneId: 's2' },
      { role: 'Composer', body: 'other', sourceProjectId: 'p1', sourceSceneId: 's1' },
    ]);
    expect(store.forRole('Writer').map((l) => l.body)).toEqual(['second', 'first']);
    expect(store.forRole('Writer', 1).map((l) => l.body)).toEqual(['second']);
    expect(store.forRole('Editor')).toEqual([]);
  });

  it('persists across a fresh instance on the same file', () => {
    createCraftMemoryStore(opts()).add([{ role: 'Director', body: 'wider', sourceProjectId: 'p', sourceSceneId: 's' }]);
    const reopened = createCraftMemoryStore(opts());
    expect(reopened.forRole('Director').map((l) => l.body)).toEqual(['wider']);
  });

  it('treats a missing or corrupt file as empty and does not throw', async () => {
    await writeFile(file, '{ not json');
    const store = createCraftMemoryStore(opts());
    expect(store.all().Writer).toEqual([]);
    store.add([{ role: 'Writer', body: 'ok now', sourceProjectId: 'p', sourceSceneId: 's' }]);
    expect(store.forRole('Writer')).toHaveLength(1);
  });

  it('caps each role and drops the oldest', () => {
    const store = createCraftMemoryStore(opts());
    for (let i = 0; i < 45; i++) {
      store.add([{ role: 'Editor', body: `note ${i}`, sourceProjectId: 'p', sourceSceneId: 's' }]);
    }
    const all = store.all().Editor;
    expect(all).toHaveLength(40);
    expect(all[0]!.body).toBe('note 44'); // newest kept
    expect(all.at(-1)!.body).toBe('note 5'); // notes 0-4 dropped
  });

  it('all() returns every persona key, newest-first', () => {
    const store = createCraftMemoryStore(opts());
    store.add([{ role: 'Cinematographer', body: 'a', sourceProjectId: 'p', sourceSceneId: 's' }]);
    const all = store.all();
    expect(Object.keys(all).sort()).toEqual(['Cinematographer', 'Composer', 'Director', 'Editor', 'Writer']);
    expect(all.Cinematographer.map((l) => l.body)).toEqual(['a']);
  });
});
