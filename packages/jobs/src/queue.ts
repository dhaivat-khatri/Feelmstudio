import type { Runtime } from '@osai/core';

import type { Job, JobResult, NewJobInput } from './job.js';
import type { NotificationSink } from './notifications.js';
import type { JobStore } from './store.js';

export type JobExecutor = (job: Job) => Promise<JobResult>;

export interface JobQueueOptions {
  readonly executor: JobExecutor;
  readonly notify?: NotificationSink;
  /** Max jobs running at once, across all projects (Journey B, F10). Default 1. */
  readonly concurrency?: number;
}

/**
 * Schedules and runs jobs against a `JobStore`. Retry policy, concurrency, and
 * terminal notification all live here — the store stays dumb CRUD plus one atomic
 * claim.
 *
 * `executor` is the seam a future inference-adapters phase plugs into, exactly the way
 * `Project.recordGeneration` is the seam @osai/core leaves for spent compute: this
 * package never runs inference itself, only schedules and tracks that it happened.
 */
export class JobQueue {
  private readonly executor: JobExecutor;
  private readonly notify: NotificationSink | undefined;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = 0;

  constructor(
    private readonly store: JobStore,
    private readonly rt: Runtime,
    options: JobQueueOptions,
  ) {
    this.executor = options.executor;
    this.notify = options.notify;
    this.concurrency = options.concurrency ?? 1;
  }

  async enqueue(input: NewJobInput): Promise<Job> {
    const now = this.rt.clock.now();
    const job: Job = {
      id: this.rt.ids.next('job'),
      projectId: input.projectId,
      nodeId: input.nodeId,
      kind: input.kind,
      payload: input.payload ?? null,
      status: 'queued',
      priority: input.priority ?? 0,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 1,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await this.store.insert(job);
    return job;
  }

  /**
   * One claim-execute-resolve cycle, refusing to exceed the concurrency limit.
   * Deterministic given an injected `now` — tests call this directly rather than
   * going through the real-time loop in `start()`. Returns the job that was claimed
   * (whatever its outcome), or undefined if there was no capacity or nothing queued.
   */
  async tick(now: string = this.rt.clock.now()): Promise<Job | undefined> {
    if (this.inFlight >= this.concurrency) return undefined;
    const job = await this.store.claimNext(now);
    if (!job) return undefined;

    this.inFlight += 1;
    try {
      await this.settle(job);
    } finally {
      this.inFlight -= 1;
    }
    return job;
  }

  /** Starts polling for work on a real interval, up to `concurrency` jobs at once. */
  start(pollMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const capacity = this.concurrency - this.inFlight;
      for (let i = 0; i < capacity; i += 1) void this.tick();
    }, pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async settle(claimed: Job): Promise<void> {
    const result = await this.executor(claimed);
    const now = this.rt.clock.now();

    if (result.ok) {
      const done: Job = { ...claimed, status: 'succeeded', updatedAt: now, finishedAt: now };
      await this.store.update(done);
      if (await this.wasApplied(done)) await this.notify?.notify({ type: 'succeeded', job: done });
      return;
    }

    const attempt = claimed.attempt + 1;
    const canRetry = result.error.retryable && attempt < claimed.maxAttempts;

    if (canRetry) {
      // Back to 'queued', not a terminal state — no notification. A retry in flight
      // is not yet "what's done, and what broke" (F9); only the eventual outcome is.
      await this.store.update({
        ...claimed,
        status: 'queued',
        attempt,
        error: result.error,
        updatedAt: now,
        startedAt: null,
      });
      return;
    }

    const failed: Job = {
      ...claimed,
      status: 'failed',
      attempt,
      error: result.error,
      updatedAt: now,
      finishedAt: now,
    };
    await this.store.update(failed);
    if (await this.wasApplied(failed)) await this.notify?.notify({ type: 'failed', job: failed });
  }

  /**
   * `store.update` silently no-ops against an already-cancelled job (its concurrency
   * contract). Re-reading before notifying is what stops a cancellation racing a
   * job's own late result from producing a "succeeded"/"failed" notification for work
   * the user already told the system to throw away (Journey B, F11).
   */
  private async wasApplied(job: Job): Promise<boolean> {
    const current = await this.store.get(job.id);
    return current?.status === job.status;
  }
}
