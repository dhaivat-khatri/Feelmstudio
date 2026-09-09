import type { NodeId, ProjectId } from '@osai/core';

/**
 * 'queued'    Waiting for a worker slot.
 * 'running'   Claimed by a worker; executing right now.
 * 'succeeded' Terminal. The executor's result has already been recorded upstream
 *             (e.g. via Project.recordGeneration) — this job just tracks that it ran.
 * 'failed'    Terminal. Either the executor's error wasn't retryable, or every retry
 *             was spent.
 * 'cancelled' Terminal. Set by cancelByProject (Journey B, F11 — scrapping a project
 *             must be as cheap as shipping one). A running job's own tick still
 *             completes, but its result is never written over a cancellation.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobError {
  readonly code: string;
  readonly message: string;
  /** Whether this specific failure is worth trying again, distinct from attempts left. */
  readonly retryable: boolean;
}

/**
 * One unit of generation work against a specific project node. What the work actually
 * *is* — which model, which prompt — is opaque `payload`; this package only schedules
 * and tracks, the same way @osai/core only records results and never spends compute.
 */
export interface Job {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly nodeId: NodeId;
  /** Free-form label for what kind of work this is, e.g. "generate", "reroll". */
  readonly kind: string;
  readonly payload: unknown;
  readonly status: JobStatus;
  /** Higher runs first. Ties break by creation order (F10: cross-project priority). */
  readonly priority: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: JobError | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface NewJobInput {
  readonly projectId: ProjectId;
  readonly nodeId: NodeId;
  readonly kind: string;
  readonly payload?: unknown;
  readonly priority?: number;
  readonly maxAttempts?: number;
}

export type JobResult = { readonly ok: true } | { readonly ok: false; readonly error: JobError };
