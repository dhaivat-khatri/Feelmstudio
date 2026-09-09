import { testRuntime } from '@osai/core';
import { describe, expect, it } from 'vitest';

import type { JobResult } from '../src/job.js';
import type { JobExecutor } from '../src/queue.js';
import { JobQueue } from '../src/queue.js';
import { InMemoryNotificationSink } from '../src/notifications.js';
import { SqliteJobStore } from '../src/sqlite-store.js';
import { createDeferred, flush, nid, pid } from './helpers.js';

describe('JobQueue — enqueue', () => {
  it('creates a queued job with defaults', async () => {
    const store = new SqliteJobStore();
    const notify = new InMemoryNotificationSink();
    const executor: JobExecutor = async () => ({ ok: true });
    const queue = new JobQueue(store, testRuntime(), { executor, notify });

    const job = await queue.enqueue({ projectId: pid('p1'), nodeId: nid('n1'), kind: 'generate' });

    expect(job.status).toBe('queued');
    expect(job.attempt).toBe(0);
    expect(job.maxAttempts).toBe(1);
    expect(job.priority).toBe(0);
    await expect(store.get(job.id)).resolves.toEqual(job);
  });
});

describe('JobQueue — running to a terminal state', () => {
  it('runs a job to success and notifies exactly once', async () => {
    const store = new SqliteJobStore();
    const notify = new InMemoryNotificationSink();
    const executor: JobExecutor = async () => ({ ok: true });
    const queue = new JobQueue(store, testRuntime(), { executor, notify });

    const job = await queue.enqueue({ projectId: pid('p1'), nodeId: nid('n1'), kind: 'generate' });
    await queue.tick();

    const loaded = await store.get(job.id);
    expect(loaded?.status).toBe('succeeded');
    expect(loaded?.finishedAt).not.toBeNull();
    expect(notify.sent).toEqual([{ type: 'succeeded', job: loaded }]);
  });

  it('does not retry a non-retryable failure, even with attempts remaining', async () => {
    const store = new SqliteJobStore();
    const notify = new InMemoryNotificationSink();
    const executor: JobExecutor = async () => ({
      ok: false,
      error: { code: 'BAD_PROMPT', message: 'rejected', retryable: false },
    });
    const queue = new JobQueue(store, testRuntime(), { executor, notify });

    const job = await queue.enqueue({
      projectId: pid('p1'),
      nodeId: nid('n1'),
      kind: 'generate',
      maxAttempts: 3,
    });
    await queue.tick();

    const loaded = await store.get(job.id);
    expect(loaded?.status).toBe('failed');
    expect(loaded?.attempt).toBe(1);
    expect(notify.sent).toHaveLength(1);
    expect(notify.sent[0]?.type).toBe('failed');
  });

  it('retries a retryable failure without notifying, then terminal-fails and notifies once attempts are spent', async () => {
    const store = new SqliteJobStore();
    const notify = new InMemoryNotificationSink();
    const executor: JobExecutor = async (): Promise<JobResult> => ({
      ok: false,
      error: { code: 'TRANSIENT', message: 'GPU busy', retryable: true },
    });
    const queue = new JobQueue(store, testRuntime(), { executor, notify });

    const job = await queue.enqueue({
      projectId: pid('p1'),
      nodeId: nid('n1'),
      kind: 'generate',
      maxAttempts: 2,
    });

    await queue.tick();
    const afterFirst = await store.get(job.id);
    expect(afterFirst?.status).toBe('queued');
    expect(afterFirst?.attempt).toBe(1);
    expect(notify.sent).toEqual([]);

    await queue.tick();
    const afterSecond = await store.get(job.id);
    expect(afterSecond?.status).toBe('failed');
    expect(afterSecond?.attempt).toBe(2);
    expect(notify.sent).toHaveLength(1);
    expect(notify.sent[0]?.type).toBe('failed');
  });

  it('succeeds on a retry that lands before attempts run out', async () => {
    const store = new SqliteJobStore();
    const notify = new InMemoryNotificationSink();
    let calls = 0;
    const executor: JobExecutor = async (): Promise<JobResult> => {
      calls += 1;
      if (calls === 1) return { ok: false, error: { code: 'TRANSIENT', message: 'busy', retryable: true } };
      return { ok: true };
    };
    const queue = new JobQueue(store, testRuntime(), { executor, notify });

    const job = await queue.enqueue({
      projectId: pid('p1'),
      nodeId: nid('n1'),
      kind: 'generate',
      maxAttempts: 3,
    });

    await queue.tick();
    await queue.tick();

    const loaded = await store.get(job.id);
    expect(loaded?.status).toBe('succeeded');
    expect(notify.sent).toHaveLength(1);
    expect(notify.sent[0]?.type).toBe('succeeded');
  });
});

describe('JobQueue — concurrency and cancellation', () => {
  it('never claims past the concurrency limit', async () => {
    const store = new SqliteJobStore();
    const gate = createDeferred<JobResult>();
    const executor: JobExecutor = async () => gate.promise;
    const queue = new JobQueue(store, testRuntime(), { executor, concurrency: 1 });

    const jobA = await queue.enqueue({ projectId: pid('p1'), nodeId: nid('n1'), kind: 'generate' });
    const jobB = await queue.enqueue({ projectId: pid('p1'), nodeId: nid('n2'), kind: 'generate' });

    const tick1 = queue.tick();
    await flush(); // let tick1 claim jobA and start executing before we try a second tick

    const tick2Result = await queue.tick();
    expect(tick2Result).toBeUndefined();
    expect((await store.get(jobB.id))?.status).toBe('queued');

    gate.resolve({ ok: true });
    await tick1;

    expect((await store.get(jobA.id))?.status).toBe('succeeded');

    const tick3 = await queue.tick();
    expect(tick3?.id).toBe(jobB.id);
  });

  it('never lets a job resolved after cancellation overwrite the cancellation, and never notifies for it', async () => {
    const store = new SqliteJobStore();
    const notify = new InMemoryNotificationSink();
    const gate = createDeferred<JobResult>();
    const executor: JobExecutor = async () => gate.promise;
    const queue = new JobQueue(store, testRuntime(), { executor, notify, concurrency: 1 });

    const job = await queue.enqueue({ projectId: pid('p1'), nodeId: nid('n1'), kind: 'generate' });

    const tickPromise = queue.tick();
    await flush(); // let it claim and start "executing"

    await store.cancelByProject(pid('p1'), 'cancelled-at');
    gate.resolve({ ok: true });
    await tickPromise;

    const loaded = await store.get(job.id);
    expect(loaded?.status).toBe('cancelled');
    expect(notify.sent).toEqual([]);
  });
});
