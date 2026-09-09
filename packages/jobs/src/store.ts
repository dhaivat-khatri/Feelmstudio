import type { ProjectId } from '@osai/core';

import type { Job, JobStatus } from './job.js';

export interface JobFilter {
  readonly projectId?: ProjectId;
  readonly status?: JobStatus;
}

/** Per-project rollup for the global Jobs workspace (Journey B, F9). */
export interface JobSummary {
  readonly projectId: ProjectId;
  readonly counts: Readonly<Record<JobStatus, number>>;
}

/**
 * A port for durable job storage. Deliberately dumb CRUD plus one atomic operation
 * (`claimNext`) — all scheduling policy (retry decisions, notification) lives in
 * `JobQueue`, not here, the same split @osai/persistence draws between `ProjectStore`
 * and `ProjectRepository`.
 */
export interface JobStore {
  insert(job: Job): Promise<void>;

  /**
   * Atomically flips the highest-priority queued job to 'running' and returns it, or
   * undefined if nothing is queued. Must be safe under concurrent callers within the
   * same process — this is what stops two workers claiming the same job.
   */
  claimNext(now: string): Promise<Job | undefined>;

  /**
   * Overwrites a job's mutable fields. Implementations must refuse to change a job
   * that is already 'cancelled' — a cancellation must never be raced by a running
   * job's own late-arriving success or failure.
   */
  update(job: Job): Promise<void>;

  get(id: string): Promise<Job | undefined>;
  list(filter?: JobFilter): Promise<readonly Job[]>;

  /** Cancels every queued/running job for a project. Returns how many were touched. */
  cancelByProject(projectId: ProjectId, now: string): Promise<number>;

  summary(): Promise<readonly JobSummary[]>;
}
