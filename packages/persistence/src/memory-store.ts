import type { ProjectId, ProjectSnapshot } from '@osai/core';

import type { ProjectListing, ProjectStore } from './store.js';

interface Entry {
  readonly snapshot: ProjectSnapshot;
  readonly savedAt: string;
}

/**
 * In-process store. Not durable across a restart — useful for tests, and for
 * developing the app layer before a real store is wired up.
 */
export class InMemoryProjectStore implements ProjectStore {
  private readonly records = new Map<ProjectId, Entry>();

  async save(snapshot: ProjectSnapshot, savedAt: string): Promise<void> {
    // Deep-cloned so a caller mutating their live Project after saving — or mutating a
    // snapshot handed back by `load` — can never reach back into what this holds.
    this.records.set(snapshot.id, { snapshot: structuredClone(snapshot), savedAt });
  }

  async load(id: ProjectId): Promise<ProjectSnapshot | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record.snapshot) : undefined;
  }

  async list(): Promise<readonly ProjectListing[]> {
    return [...this.records.entries()].map(([id, { snapshot, savedAt }]) => ({
      id,
      title: snapshot.title,
      lifecycle: snapshot.lifecycle,
      savedAt,
    }));
  }

  async delete(id: ProjectId): Promise<void> {
    this.records.delete(id);
  }
}
