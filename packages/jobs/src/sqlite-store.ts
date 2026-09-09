import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { projectId as toProjectId, nodeId as toNodeId, type ProjectId } from '@osai/core';

import type { Job, JobError, JobStatus } from './job.js';
import type { JobFilter, JobStore, JobSummary } from './store.js';

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs (project_id);
`;

interface Row {
  id: string;
  project_id: string;
  node_id: string;
  kind: string;
  payload: string;
  status: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * SQLite-backed job store, using Node's built-in `node:sqlite` (Node 22+) rather than
 * a native-binary dependency like better-sqlite3 — one less thing that can fail to
 * compile on a given platform.
 *
 * Jobs need to be queried by status/priority/project (the global Jobs workspace,
 * cross-project concurrency), which is a different access pattern than
 * @osai/persistence's one-file-per-project store — that's the reason this phase
 * reaches for a real, queryable store instead of reusing that pattern.
 */
export class SqliteJobStore implements JobStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly claimStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly cancelByProjectStmt: StatementSync;

  /** `location` is a file path, or ':memory:' (the default) for tests. */
  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.db.exec(SCHEMA);

    this.insertStmt = this.db.prepare(`
      INSERT INTO jobs (
        id, project_id, node_id, kind, payload, status, priority, attempt,
        max_attempts, error, created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.claimStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'queued'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);

    this.getStmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');

    this.cancelByProjectStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'cancelled', updated_at = ?, finished_at = ?
      WHERE project_id = ? AND status IN ('queued', 'running')
    `);
  }

  async insert(job: Job): Promise<void> {
    this.insertStmt.run(
      job.id,
      job.projectId,
      job.nodeId,
      job.kind,
      JSON.stringify(job.payload ?? null),
      job.status,
      job.priority,
      job.attempt,
      job.maxAttempts,
      job.error ? JSON.stringify(job.error) : null,
      job.createdAt,
      job.updatedAt,
      job.startedAt,
      job.finishedAt,
    );
  }

  async claimNext(now: string): Promise<Job | undefined> {
    const row = this.claimStmt.get(now, now) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  async update(job: Job): Promise<void> {
    // The WHERE guard is the concurrency contract: a job already cancelled by
    // cancelByProject can never be overwritten by a running executor's late result.
    this.db
      .prepare(
        `UPDATE jobs SET
          status = ?, priority = ?, attempt = ?, max_attempts = ?, payload = ?,
          error = ?, updated_at = ?, started_at = ?, finished_at = ?
        WHERE id = ? AND status <> 'cancelled'`,
      )
      .run(
        job.status,
        job.priority,
        job.attempt,
        job.maxAttempts,
        JSON.stringify(job.payload ?? null),
        job.error ? JSON.stringify(job.error) : null,
        job.updatedAt,
        job.startedAt,
        job.finishedAt,
        job.id,
      );
  }

  async get(id: string): Promise<Job | undefined> {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(filter: JobFilter = {}): Promise<readonly Job[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at ASC`)
      .all(...params) as unknown as Row[];
    return rows.map(fromRow);
  }

  async cancelByProject(projectId: ProjectId, now: string): Promise<number> {
    const result = this.cancelByProjectStmt.run(now, now, projectId);
    return Number(result.changes);
  }

  async summary(): Promise<readonly JobSummary[]> {
    const rows = this.db
      .prepare('SELECT project_id, status, COUNT(*) as n FROM jobs GROUP BY project_id, status')
      .all() as Array<{ project_id: string; status: string; n: number }>;

    const byProject = new Map<string, Record<JobStatus, number>>();
    for (const row of rows) {
      const counts = byProject.get(row.project_id) ?? zeroCounts();
      counts[row.status as JobStatus] = row.n;
      byProject.set(row.project_id, counts);
    }

    return [...byProject.entries()].map(([id, counts]) => ({
      projectId: toProjectId(id),
      counts,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function zeroCounts(): Record<JobStatus, number> {
  const counts = {} as Record<JobStatus, number>;
  for (const status of STATUSES) counts[status] = 0;
  return counts;
}

function fromRow(row: Row): Job {
  return {
    id: row.id,
    projectId: toProjectId(row.project_id),
    nodeId: toNodeId(row.node_id),
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status as JobStatus,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error ? (JSON.parse(row.error) as JobError) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
