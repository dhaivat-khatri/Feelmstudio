import type { ProjectGraph } from './graph.js';
import type { NodeId } from './ids.js';
import type { NodeKind } from './kinds.js';
import type { ArtifactNode, NodeStatus } from './node.js';
import type { Project } from './project.js';
import type { PropagationReport } from './staleness.js';

/**
 * An agent is a function that produces the payload for one node kind. That is the
 * whole abstraction.
 *
 * There is deliberately no orchestrator, scheduler, or message bus here: the project
 * graph already is one. `topoOrder` says what runs before what, `dependenciesOf` says
 * what the inputs are, and `propagate` says what a result invalidates. A multi-agent
 * framework on top would duplicate all three.
 */
export interface AgentRequest {
  readonly node: ArtifactNode;
  readonly graph: ProjectGraph;
  /** Current payloads of this node's direct dependencies, keyed by node id. */
  readonly inputs: ReadonlyMap<NodeId, unknown>;
  readonly signal: AbortSignal | undefined;
}

export interface AgentResult {
  readonly payload: unknown;
  /** Recorded as provenance so the generation can be reproduced (PRD §5.2). */
  readonly prompt?: string;
  readonly seed?: number;
  readonly model?: string;
}

export type Agent = (request: AgentRequest) => Promise<AgentResult>;

/** Which agent owns which node kind. Unlisted kinds simply have no agent yet. */
export type AgentRegistry = Partial<Record<NodeKind, Agent>>;

/**
 * Display names for the crew, so the jobs queue reads "Cinematographer · Scene 3"
 * rather than "scenePlan · s3:plan". Real film-crew roles rather than invented
 * codenames — a creator already knows what a director does, and the name doubles as
 * the explanation of what that agent is allowed to decide.
 */
export const AGENT_NAMES: Partial<Record<NodeKind, string>> = {
  style: 'Director',
  research: 'Researcher',
  script: 'Writer',
  sceneScript: 'Writer',
  scenePlan: 'Cinematographer',
  storyboardFrame: 'Storyboard artist',
  character: 'Casting',
  voice: 'Casting',
  sceneImage: 'Concept artist',
  sceneVideo: 'Animator',
  narration: 'Voice actor',
  music: 'Composer',
  sfx: 'Sound designer',
  subtitles: 'Subtitler',
  colorGrade: 'Colorist',
  timeline: 'Editor',
  export: 'Post',
};

/** Crew name for a node kind, falling back to the kind itself. */
export const agentName = (kind: NodeKind): string => AGENT_NAMES[kind] ?? kind;

export interface AgentPersona {
  readonly name: string;
  readonly role: string;
  readonly tagline: string;
  readonly color: string;
}

export type PersonaRole = 'Director' | 'Writer' | 'Cinematographer' | 'Composer' | 'Editor';

/**
 * The five crew roles with a named, illustrated persona (see agents.png). The other
 * AGENT_NAMES roles (Researcher, Casting, Concept artist, ...) are real crew but don't
 * have a persona card — personaFor returns undefined for those, not a placeholder.
 */
export const AGENT_PERSONAS: Record<PersonaRole, AgentPersona> = {
  Director: {
    name: 'Ezra Vantage',
    role: 'Director',
    tagline: 'Sees the big picture. Brings the vision to life.',
    color: '#F5A623',
  },
  Writer: {
    name: 'Lyra Inkwell',
    role: 'Writer',
    tagline: 'Crafts worlds. Writes emotions. Words that move.',
    color: '#9B59B6',
  },
  Cinematographer: {
    name: 'Revo Luxin',
    role: 'Cinematographer',
    tagline: 'Frames moments. Captures magic in motion.',
    color: '#1ABC9C',
  },
  Composer: {
    name: 'Sonic Vyra',
    role: 'Composer',
    tagline: 'Creates the feeling. Makes stories unforgettable.',
    color: '#E91E8C',
  },
  Editor: {
    name: 'Kai Cutter',
    role: 'Editor',
    tagline: 'Shapes the story. Every cut. Every beat. Perfected.',
    color: '#2ECC71',
  },
};

const isPersonaRole = (role: string): role is PersonaRole =>
  role === 'Director' || role === 'Writer' || role === 'Cinematographer' || role === 'Composer' || role === 'Editor';

/** Persona for a node kind's crew role, when that role has one (5 of the crew do). */
export function personaFor(kind: NodeKind): AgentPersona | undefined {
  const role = AGENT_NAMES[kind];
  return role && isPersonaRole(role) ? AGENT_PERSONAS[role] : undefined;
}

// Worst-first, same convention as a scene card's own status rollup.
const AGENT_STATUS_PRECEDENCE: readonly NodeStatus[] = [
  'failed',
  'generating',
  'queued',
  'needsReview',
  'notStarted',
  'approved',
];

/**
 * Rolls every node's status up to its persona role — the Studio Command Center's
 * "agent status at a glance," the five personas from AGENT_PERSONAS only.
 */
export function agentStatusOf(project: Project): Record<PersonaRole, NodeStatus> {
  const byRole = new Map<PersonaRole, NodeStatus[]>();
  for (const node of project.graph.nodes) {
    const role = AGENT_NAMES[node.kind];
    if (!role || !isPersonaRole(role)) continue;
    const list = byRole.get(role) ?? [];
    list.push(node.status);
    byRole.set(role, list);
  }
  const result = {} as Record<PersonaRole, NodeStatus>;
  for (const role of Object.keys(AGENT_PERSONAS) as PersonaRole[]) {
    const statuses = byRole.get(role) ?? [];
    result[role] = AGENT_STATUS_PRECEDENCE.find((s) => statuses.includes(s)) ?? 'notStarted';
  }
  return result;
}

/** Current payloads of everything a node depends on. */
export function inputsOf(graph: ProjectGraph, id: NodeId): ReadonlyMap<NodeId, unknown> {
  const inputs = new Map<NodeId, unknown>();
  for (const depId of graph.dependenciesOf(id)) {
    const current = graph.require(depId).current;
    if (current) inputs.set(depId, current.payload);
  }
  return inputs;
}

const wantsWork = (node: ArtifactNode): boolean =>
  node.status === 'notStarted' ||
  node.status === 'failed' ||
  node.staleness?.kind === 'outOfDate' ||
  node.staleness?.kind === 'needsReview';

/**
 * Nodes an agent could run right now: they need work, something can produce them, and
 * every dependency already has a version to read. Returned in dependency-safe order,
 * so a caller draining the list never generates a scene before its plan exists.
 */
export function readyToRun(project: Project, registry: AgentRegistry): readonly NodeId[] {
  const { graph } = project;
  return graph.topoOrder().filter((id) => {
    const node = graph.require(id);
    if (!registry[node.kind] || !wantsWork(node)) return false;
    return graph.dependenciesOf(id).every((depId) => graph.require(depId).hasVersions);
  });
}

/**
 * Runs the agent for one node and records the result. Returns null when no agent is
 * registered for that kind. A throwing agent marks the node failed and rethrows —
 * swallowing it would leave the node looking merely unstarted.
 */
export async function runNode(
  project: Project,
  id: NodeId,
  registry: AgentRegistry,
  signal?: AbortSignal,
): Promise<PropagationReport | null> {
  const node = project.graph.require(id);
  const agent = registry[node.kind];
  if (!agent) return null;

  node.setStatus('generating');
  try {
    const result = await agent({
      node,
      graph: project.graph,
      inputs: inputsOf(project.graph, id),
      signal,
    });
    return project.recordGeneration(id, result.payload, {
      ...(result.prompt !== undefined && { prompt: result.prompt }),
      ...(result.seed !== undefined && { seed: result.seed }),
      ...(result.model !== undefined && { model: result.model }),
    });
  } catch (error) {
    project.fail(id, {
      code: 'AGENT_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
    throw error;
  }
}
