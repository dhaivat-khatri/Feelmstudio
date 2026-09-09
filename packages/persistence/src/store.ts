import type { ProjectId, ProjectLifecycle, ProjectSnapshot } from '@osai/core';

/** Lightweight metadata for listing projects without loading a full graph. */
export interface ProjectListing {
  readonly id: ProjectId;
  readonly title: string;
  readonly lifecycle: ProjectLifecycle;
  readonly savedAt: string;
}

/**
 * A port for durable project storage.
 *
 * Deliberately snapshot-in, snapshot-out: a store only ever moves the opaque,
 * already-JSON-safe data that `Project.toSnapshot` produces. It never touches graph
 * invariants — those stay owned by @osai/core, the same way inference stays out of it.
 * `savedAt` is caller-supplied rather than read from a clock here, so a store's
 * behaviour stays deterministic under test.
 */
export interface ProjectStore {
  save(snapshot: ProjectSnapshot, savedAt: string): Promise<void>;
  load(id: ProjectId): Promise<ProjectSnapshot | undefined>;
  list(): Promise<readonly ProjectListing[]>;
  delete(id: ProjectId): Promise<void>;
}
