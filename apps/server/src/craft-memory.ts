import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Learning, PersonaRole } from '@osai/core';

const ROLES: readonly PersonaRole[] = ['Director', 'Writer', 'Cinematographer', 'Composer', 'Editor'];
const PER_ROLE_CAP = 40;
const DEFAULT_LIMIT = 8;

export interface LearningInput {
  readonly role: PersonaRole;
  readonly body: string;
  readonly sourceProjectId: string;
  readonly sourceSceneId: string;
}

export interface CraftMemoryStore {
  /** Append lessons; returns the persisted rows. Best-effort — a write failure is logged, not thrown. */
  add(inputs: readonly LearningInput[]): Learning[];
  /** One role's lessons, newest first, capped at `limit` (default 8). */
  forRole(role: PersonaRole, limit?: number): Learning[];
  /** Every role's lessons, newest first. All five keys always present. */
  all(): Record<PersonaRole, Learning[]>;
}

type RawStore = Record<string, Learning[]>;

function emptyStore(): Record<PersonaRole, Learning[]> {
  return { Director: [], Writer: [], Cinematographer: [], Composer: [], Editor: [] };
}

function readStore(filePath: string): Record<PersonaRole, Learning[]> {
  const out = emptyStore();
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return out; // missing file — fine
  }
  try {
    const parsed = JSON.parse(raw) as RawStore;
    for (const role of ROLES) {
      const rows = parsed[role];
      if (Array.isArray(rows)) out[role] = rows.filter((r): r is Learning => !!r && typeof r.body === 'string');
    }
  } catch {
    console.warn(`[craft-memory] ${filePath} was not valid JSON — starting empty.`);
  }
  return out;
}

function buildRows(inputs: readonly LearningInput[], nextId: () => string, now: () => string): Learning[] {
  return inputs
    .filter((i) => ROLES.includes(i.role) && i.body.trim().length > 0)
    .map((i) => ({
      id: nextId(),
      role: i.role,
      body: i.body.trim(),
      sourceProjectId: i.sourceProjectId,
      sourceSceneId: i.sourceSceneId,
      createdAt: now(),
    }));
}

/** File-backed craft memory. The file is small and writes are infrequent, so sync IO is fine. */
export function createCraftMemoryStore(opts: {
  filePath: string;
  now: () => string;
  nextId: () => string;
}): CraftMemoryStore {
  const state = readStore(opts.filePath);

  const persist = () => {
    try {
      mkdirSync(dirname(opts.filePath), { recursive: true });
      writeFileSync(opts.filePath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn(`[craft-memory] could not write ${opts.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    add(inputs) {
      const created = buildRows(inputs, opts.nextId, opts.now);
      for (const row of created) {
        state[row.role].push(row);
        if (state[row.role].length > PER_ROLE_CAP) state[row.role] = state[row.role].slice(-PER_ROLE_CAP);
      }
      if (created.length > 0) persist();
      return created;
    },
    forRole(role, limit = DEFAULT_LIMIT) {
      return [...(state[role] ?? [])].reverse().slice(0, limit);
    },
    all() {
      const out = emptyStore();
      for (const role of ROLES) out[role] = [...state[role]].reverse();
      return out;
    },
  };
}

/** In-memory craft memory for tests — no disk. */
export function createInMemoryCraftMemoryStore(opts?: { now?: () => string; nextId?: () => string }): CraftMemoryStore {
  const state = emptyStore();
  let seq = 0;
  const now = opts?.now ?? (() => new Date().toISOString());
  const nextId = opts?.nextId ?? (() => `learn_${++seq}`);
  return {
    add(inputs) {
      const created = buildRows(inputs, nextId, now);
      for (const row of created) state[row.role].push(row);
      return created;
    },
    forRole(role, limit = DEFAULT_LIMIT) {
      return [...state[role]].reverse().slice(0, limit);
    },
    all() {
      const out = emptyStore();
      for (const role of ROLES) out[role] = [...state[role]].reverse();
      return out;
    },
  };
}
