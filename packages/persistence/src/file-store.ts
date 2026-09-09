import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProjectId, ProjectSnapshot } from '@osai/core';

import type { ProjectListing, ProjectStore } from './store.js';

interface FileRecord {
  readonly snapshot: ProjectSnapshot;
  readonly savedAt: string;
}

/**
 * One JSON file per project under `dir`. This is what makes a project survive a
 * process restart (F3 in the user journeys: Maya closes the laptop mid-queue).
 *
 * Writes land via a temp file plus rename rather than a direct write, because rename
 * is atomic on the same filesystem — a crash mid-write can never leave a half-written
 * file where a later `load` would find it.
 */
export class FileProjectStore implements ProjectStore {
  constructor(private readonly dir: string) {}

  async save(snapshot: ProjectSnapshot, savedAt: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const record: FileRecord = { snapshot, savedAt };
    const target = this.pathFor(snapshot.id);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async load(id: ProjectId): Promise<ProjectSnapshot | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), 'utf8');
      return (JSON.parse(raw) as FileRecord).snapshot;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async list(): Promise<readonly ProjectListing[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }

    const listings: ProjectListing[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const raw = await readFile(join(this.dir, entry), 'utf8');
      const { snapshot, savedAt } = JSON.parse(raw) as FileRecord;
      listings.push({
        id: snapshot.id,
        title: snapshot.title,
        lifecycle: snapshot.lifecycle,
        savedAt,
      });
    }
    return listings;
  }

  async delete(id: ProjectId): Promise<void> {
    try {
      await rm(this.pathFor(id));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private pathFor(id: ProjectId): string {
    return join(this.dir, `${id}.json`);
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
