import type {
  Learning,
  MusicPayload,
  NodeFailure,
  NodeStatus,
  PersonaRole,
  ProjectLifecycle,
  ProjectOverview,
  ProposedSegment,
  RoomEntry,
  ScenePart,
  SegmentationDiff,
  StalenessKind,
  StylePayload,
} from '@osai/core';
import type { Job, JobSummary } from '@osai/jobs';
import type { ProjectListing } from '@osai/persistence';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : res.statusText;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export interface ScenePartDetail {
  readonly status: NodeStatus;
  readonly staleness: StalenessKind | null;
  readonly failure: NodeFailure | null;
  readonly payload: unknown;
  readonly mediaUrl?: string;
}

export interface SceneDetail {
  readonly sceneId: string;
  readonly ordinal: number;
  readonly heading: string | undefined;
  readonly status: NodeStatus;
  readonly staleness: StalenessKind | null;
  readonly needsAttention: boolean;
  readonly parts: Record<ScenePart, ScenePartDetail>;
}

export const api = {
  listProjects: () => request<readonly ProjectListing[]>('/projects'),
  createProject: (title: string) => request<ProjectOverview>('/projects', post({ title })),
  getProject: (id: string) => request<ProjectOverview>(`/projects/${id}`),
  setLifecycle: (id: string, lifecycle: ProjectLifecycle) =>
    request<ProjectOverview>(`/projects/${id}/lifecycle`, post({ lifecycle })),

  saveScript: (id: string, segments: ProposedSegment[]) =>
    request<{ applied: boolean; overview?: ProjectOverview; diff?: SegmentationDiff }>(
      `/projects/${id}/script`,
      post({ segments }),
    ),
  applySegmentation: (id: string, diff: SegmentationDiff) =>
    request<{ report: unknown; overview: ProjectOverview }>(`/projects/${id}/segmentation/apply`, post({ diff })),

  approveAll: (id: string) =>
    request<{ approved: number; overview: ProjectOverview }>(`/projects/${id}/approve-all`, post({})),

  /** Editor: manual reorder/exclude for the assembled cut. */
  trimTimeline: (id: string, order: readonly string[]) =>
    request<{ overview: ProjectOverview }>(`/projects/${id}/timeline/trim`, post({ order })),
  resetTimeline: (id: string) =>
    request<{ overview: ProjectOverview }>(`/projects/${id}/timeline/reset`, post({})),

  getDecisions: (id: string) =>
    request<{
      decisions: readonly {
        nodeId: string;
        kind: string;
        label: string;
        sceneId: string | null;
        agent: string;
        versionIndex: number;
        createdAt: string;
        authorship: string;
        prompt: string | null;
        model: string | null;
        seed: number | null;
      }[];
    }>(`/projects/${id}/decisions`),

  getScene: (id: string, sceneId: string) => request<SceneDetail>(`/projects/${id}/scenes/${sceneId}`),
  acknowledgeScene: (id: string, sceneId: string) =>
    request<{ cleared: number }>(`/projects/${id}/scenes/${sceneId}/acknowledge`, post({})),

  /** Director: sets the project's creative brief from a one-line idea. */
  generateStyle: (id: string, idea: string) =>
    request<{ style: StylePayload; overview: ProjectOverview }>(`/projects/${id}/style/generate`, post({ idea })),
  /** Cinematographer: shot type/framing/camera move for one scene. */
  generatePlan: (id: string, sceneId: string) =>
    request<{ scene: unknown }>(`/projects/${id}/scenes/${sceneId}/plan/generate`, post({})),
  /** Composer: musical direction for the score, from the current style brief. */
  generateMusic: (id: string) =>
    request<{ music: MusicPayload; overview: ProjectOverview }>(`/projects/${id}/music/generate`, post({})),
  /** Writer: drafts the full script from an idea (+ current style brief). Not committed — see saveScript. */
  generateScript: (id: string, idea: string) =>
    request<{ script: string }>(`/projects/${id}/script/generate`, post({ idea })),

  generate: (id: string, sceneId: string, part: 'image' | 'video' | 'narration', prompt: string, seed?: number) =>
    request<Job>(
      `/projects/${id}/scenes/${sceneId}/generate`,
      post({ part, prompt, ...(seed !== undefined && { seed }) }),
    ),

  listJobs: (id: string) => request<readonly Job[]>(`/projects/${id}/jobs`),
  cancelJobs: (id: string) => request<{ cancelled: number }>(`/projects/${id}/jobs/cancel`, post({})),
  globalJobs: () => request<readonly JobSummary[]>('/jobs'),

  /** The Rooms tab: run one scene huddle, all of them, or read the log + lessons. */
  deliberateScene: (id: string, sceneId: string) =>
    request<{ entries: RoomEntry[]; learnings: Learning[] }>(`/projects/${id}/scenes/${sceneId}/deliberate`, post({})),
  deliberateAll: (id: string) =>
    request<{ scenes: Array<{ sceneId: string; entries: RoomEntry[]; learnings: Learning[] }> }>(
      `/projects/${id}/deliberate`,
      post({}),
    ),
  getRooms: (id: string) =>
    request<{ entries: RoomEntry[]; learnings: Record<PersonaRole, Learning[]> }>(`/projects/${id}/rooms`),
};
