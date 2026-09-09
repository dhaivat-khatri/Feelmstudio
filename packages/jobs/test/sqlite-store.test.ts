import { describe, expect, it } from 'vitest';

import type { Job } from '../src/job.js';
import { SqliteJobStore } from '../src/sqlite-store.js';
import { nid, pid } from './helpers.js';

function job(overrides: Partial<Job> = {}): Job {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: overrides.id ?? 'job_1',
    projectId: pid('p1'),
    nodeId: nid('n1'),
    kind: 'generate',
    payload: { prompt: 'wide shot' },
    status: 'queued',
    priority: 0,
    attempt: 0,
    maxAttempts: 1,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('SqliteJobStore', () => {
  it('round-trips an inserted job, including payload', async () => {
    const store = new SqliteJobStore();
    await store.insert(job());

    const loaded = await store.get('job_1');
    expect(loaded).toEqual(job());
  });

  it('returns undefined for a job that does not exist', async () => {
    const store = new SqliteJobStore();
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('claimNext returns undefined when nothing is queued', async () => {
    const store = new SqliteJobStore();
    await expect(store.claimNext('2026-01-01T00:00:00.000Z')).resolves.toBeUndefined();
  });

  it('claimNext flips the job to running and stamps startedAt', async () => {
    const store = new SqliteJobStore();
    await store.insert(job());

    const claimed = await store.claimNext('2026-01-01T00:05:00.000Z');

    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBe('2026-01-01T00:05:00.000Z');
    expect((await store.get('job_1'))?.status).toBe('running');
  });

  it('claims higher priority first, ties broken by creation order', async () => {
    const store = new SqliteJobStore();
    await store.insert(job({ id: 'a', priority: 0, createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.insert(job({ id: 'b', priority: 5, createdAt: '2026-01-01T00:00:01.000Z' }));
    await store.insert(job({ id: 'c', priority: 5, createdAt: '2026-01-01T00:00:00.500Z' }));

    const first = await store.claimNext('t1');
    const second = await store.claimNext('t2');
    const third = await store.claimNext('t3');

    expect([first?.id, second?.id, third?.id]).toEqual(['c', 'b', 'a']);
  });

  it('never claims a running, terminal, or cancelled job again', async () => {
    const store = new SqliteJobStore();
    await store.insert(job({ id: 'a' }));
    await store.claimNext('t1');

    await expect(store.claimNext('t2')).resolves.toBeUndefined();
  });

  it('update overwrites mutable fields', async () => {
    const store = new SqliteJobStore();
    await store.insert(job());

    await store.update({
      ...job(),
      status: 'succeeded',
      updatedAt: 't2',
      finishedAt: 't2',
    });

    const loaded = await store.get('job_1');
    expect(loaded?.status).toBe('succeeded');
    expect(loaded?.finishedAt).toBe('t2');
  });

  it('update refuses to change a job that is already cancelled', async () => {
    const store = new SqliteJobStore();
    await store.insert(job());
    await store.cancelByProject(pid('p1'), 'cancelled-at');

    await store.update({ ...job(), status: 'succeeded', updatedAt: 'late', finishedAt: 'late' });

    const loaded = await store.get('job_1');
    expect(loaded?.status).toBe('cancelled');
  });

  it('cancelByProject cancels only queued/running jobs in that project, and reports the count', async () => {
    const store = new SqliteJobStore();
    await store.insert(job({ id: 'a', projectId: pid('p1') }));
    await store.insert(job({ id: 'b', projectId: pid('p1'), status: 'succeeded' }));
    await store.insert(job({ id: 'c', projectId: pid('p2') }));

    const count = await store.cancelByProject(pid('p1'), 'now');

    expect(count).toBe(1);
    expect((await store.get('a'))?.status).toBe('cancelled');
    expect((await store.get('b'))?.status).toBe('succeeded');
    expect((await store.get('c'))?.status).toBe('queued');
  });

  it('lists jobs filtered by project and status', async () => {
    const store = new SqliteJobStore();
    await store.insert(job({ id: 'a', projectId: pid('p1'), status: 'queued' }));
    await store.insert(job({ id: 'b', projectId: pid('p1'), status: 'succeeded' }));
    await store.insert(job({ id: 'c', projectId: pid('p2'), status: 'queued' }));

    await expect(store.list({ projectId: pid('p1') })).resolves.toHaveLength(2);
    await expect(store.list({ status: 'queued' })).resolves.toHaveLength(2);
    await expect(store.list({ projectId: pid('p1'), status: 'succeeded' })).resolves.toHaveLength(1);
    await expect(store.list()).resolves.toHaveLength(3);
  });

  it('summarizes per-project status counts for the global Jobs workspace', async () => {
    const store = new SqliteJobStore();
    await store.insert(job({ id: 'a', projectId: pid('p1'), status: 'queued' }));
    await store.insert(job({ id: 'b', projectId: pid('p1'), status: 'failed' }));
    await store.insert(job({ id: 'c', projectId: pid('p2'), status: 'succeeded' }));

    const summary = await store.summary();
    const byProject = new Map(summary.map((s) => [s.projectId, s.counts]));

    expect(byProject.get(pid('p1'))).toMatchObject({ queued: 1, failed: 1, succeeded: 0 });
    expect(byProject.get(pid('p2'))).toMatchObject({ succeeded: 1, queued: 0 });
  });
});
