import type { Project, ProjectId } from '@osai/core';
import type { Job, JobError, JobExecutor, JobResult } from '@osai/jobs';

import { InferenceError, type Capability, type InferenceAdapter, type InferenceRequest } from './adapter.js';

/**
 * What `createInferenceExecutor` needs to turn a job's `projectId` into a live
 * `Project` and persist the result. Shaped to match `@osai/persistence`'s
 * `ProjectRepository` exactly (structurally — no dependency on that package), so a
 * real repository can be passed in directly.
 */
export interface ProjectLookup {
  get(id: ProjectId): Promise<Project | undefined>;
  save(project: Project): Promise<void>;
}

/**
 * Builds the `JobExecutor` that `@osai/jobs`'s `JobQueue` calls. This is the seam
 * completing: job → adapter.generate → Project.recordGeneration → persisted.
 *
 * Convention: `job.kind` is a `Capability` string, and `job.payload` is an
 * `InferenceRequest` — enqueuers are responsible for shaping both correctly.
 */
export function createInferenceExecutor(
  adapters: ReadonlyMap<Capability, InferenceAdapter>,
  projects: ProjectLookup,
): JobExecutor {
  return async (job: Job): Promise<JobResult> => {
    const project = await projects.get(job.projectId);
    if (!project) {
      return {
        ok: false,
        error: { code: 'PROJECT_NOT_FOUND', message: `No project "${job.projectId}"`, retryable: false },
      };
    }

    // Every failure branch below marks the node itself, not just the job record — the
    // sync-Agent path (runNode) does this via project.fail() in its catch block, and
    // this path must match it exactly, or a real generation failure updates the Jobs
    // panel but leaves the scene grid showing stale status forever.
    const fail = async (error: JobError): Promise<JobResult> => {
      project.fail(job.nodeId, error);
      await projects.save(project);
      return { ok: false, error };
    };

    const adapter = adapters.get(job.kind as Capability);
    if (!adapter) {
      return fail({ code: 'UNKNOWN_CAPABILITY', message: `No adapter for "${job.kind}"`, retryable: false });
    }

    if (!isInferenceRequest(job.payload)) {
      return fail({ code: 'INVALID_PAYLOAD', message: 'Job payload is not an InferenceRequest', retryable: false });
    }

    try {
      const result = await adapter.generate(job.payload);
      project.recordGeneration(job.nodeId, result.payload, {
        prompt: job.payload.prompt,
        ...(result.seed !== undefined && { seed: result.seed }),
        model: result.model,
      });
      await projects.save(project);
      return { ok: true };
    } catch (err) {
      return fail(toJobError(err));
    }
  };
}

function isInferenceRequest(payload: unknown): payload is InferenceRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { prompt?: unknown }).prompt === 'string'
  );
}

function toJobError(err: unknown): JobError {
  if (err instanceof InferenceError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN_ERROR', message: err.message, retryable: false };
  }
  return { code: 'UNKNOWN_ERROR', message: String(err), retryable: false };
}
