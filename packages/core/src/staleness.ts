import { deepEqual } from './equality.js';
import type { ProjectGraph } from './graph.js';
import type { NodeId, VersionId } from './ids.js';
import { acceptsStalenessFlags, type ProjectLifecycle } from './lifecycle.js';
import type { ArtifactNode, Staleness, StalenessKind } from './node.js';
import type { Runtime } from './runtime.js';
import { type UpstreamRef, upstreamRef } from './version.js';

/**
 * What kind of change happened at the origin node.
 *
 *   'content'   A new version of the same artifact. Dependents are out of date.
 *   'structure' The shape or identity of the thing moved underneath its dependents —
 *               re-segmentation being the case that matters. Dependents can't just be
 *               regenerated; a human has to confirm they still belong.
 */
export type ChangeNature = 'content' | 'structure';

export interface ChangeEvent {
  readonly nodeId: NodeId;
  readonly versionId: VersionId;
  readonly nature: ChangeNature;
}

export interface RecomputeRequest {
  readonly node: ArtifactNode;
  readonly graph: ProjectGraph;
  readonly causes: readonly UpstreamRef[];
}

/**
 * Supplies fresh content for a derived node. Returning null means "can't recompute
 * this right now", and the node is flagged out of date instead — the engine never
 * claims a node caught up when it didn't.
 */
export type Recomputer = (request: RecomputeRequest) => { payload: unknown } | null;

/**
 * 'unchanged' is the pruning path: a derived node recomputed to exactly what it
 * already held, so nothing beneath it can be out of date either.
 *
 * 'unrelated' means no involved dependency could be blamed. It is reachable only
 * downstream of a pruned node — anything else reachable along dependent edges has, by
 * construction, something to blame. Kept explicit so a traversal bug surfaces as a
 * visible skip rather than quietly masquerading as an acknowledged node.
 */
export type SkipReason = 'notStarted' | 'acknowledged' | 'unchanged' | 'unrelated';

export interface PropagateOptions {
  readonly lifecycle?: ProjectLifecycle;
  readonly recompute?: Recomputer;
  /** Decides whether a recompute actually produced anything new. Defaults to deepEqual. */
  readonly equals?: (a: unknown, b: unknown) => boolean;
}

export interface FlaggedNode {
  readonly nodeId: NodeId;
  readonly staleness: Staleness;
}

export interface SkippedNode {
  readonly nodeId: NodeId;
  readonly reason: SkipReason;
}

export interface PropagationReport {
  readonly origin: ChangeEvent;
  /** Every node downstream of the origin, in dependency-safe order. */
  readonly affected: readonly NodeId[];
  readonly recomputed: readonly NodeId[];
  readonly flagged: readonly FlaggedNode[];
  readonly skipped: readonly SkippedNode[];
  /** True when the project's lifecycle meant nothing was flagged at all. */
  readonly suppressedByLifecycle: boolean;
}

/** The upstream refs a node would be generated from right now. */
export function currentUpstreamOf(graph: ProjectGraph, id: NodeId): readonly UpstreamRef[] {
  return graph.dependenciesOf(id).flatMap((depId) => {
    const current = graph.require(depId).current;
    return current ? [upstreamRef(depId, current.id)] : [];
  });
}

/**
 * Walks the origin's dependents and decides, per node, what should happen. The
 * confirmed PRD §5.3 semantics: flag immediately and visibly, never regenerate media
 * on the user's behalf, and let cheap derived text catch up on its own.
 *
 * Nothing here schedules work or spends compute. Regeneration is always an explicit,
 * separate user action.
 */
export function propagate(
  graph: ProjectGraph,
  change: ChangeEvent,
  rt: Runtime,
  options: PropagateOptions = {},
): PropagationReport {
  const lifecycle = options.lifecycle ?? 'active';
  const equals = options.equals ?? deepEqual;
  const affected = graph.transitiveDependents(change.nodeId);

  if (!acceptsStalenessFlags(lifecycle)) {
    return {
      origin: change,
      affected,
      recomputed: [],
      flagged: [],
      skipped: [],
      suppressedByLifecycle: true,
    };
  }

  const at = rt.clock.now();
  const affectedSet = new Set(affected);

  /** Origin and any node we actually produced a new version for. */
  const changedVersions = new Map<NodeId, VersionId>([[change.nodeId, change.versionId]]);
  /** Causes attributed to each affected node, so downstream nodes can inherit them. */
  const causesByNode = new Map<NodeId, readonly UpstreamRef[]>();

  const recomputed: NodeId[] = [];
  const flagged: FlaggedNode[] = [];
  const skipped: SkippedNode[] = [];

  for (const id of affected) {
    const node = graph.require(id);
    const causes = resolveCauses(graph, id, change, affectedSet, changedVersions, causesByNode);
    causesByNode.set(id, causes);

    // Nothing to attribute the change to means this node is not genuinely downstream.
    if (causes.length === 0) {
      skipped.push({ nodeId: id, reason: 'unrelated' });
      continue;
    }

    // A node that has never produced anything cannot be out of date with anything.
    if (!node.hasVersions) {
      skipped.push({ nodeId: id, reason: 'notStarted' });
      continue;
    }

    // Structural changes are never auto-resolved — that is the whole point of the state.
    const canAutoResolve = change.nature === 'content' && node.isAutoRecomputable;
    if (canAutoResolve && options.recompute) {
      const result = options.recompute({ node, graph, causes });
      if (result) {
        // Pruning. If the recompute landed on exactly what this node already held, the
        // node genuinely did not change, so nothing beneath it can be out of date.
        // Clearing its causes stops the walk here: dependents that reach the origin
        // only through this node will find nothing to blame and skip as 'unrelated'.
        //
        // This is what keeps a whole-script edit scoped. Every scene's slice is
        // re-derived, but the eighteen slices whose text did not move prune
        // themselves, and only scene 9's media is ever flagged.
        if (equals(node.current?.payload, result.payload)) {
          causesByNode.set(id, []);
          skipped.push({ nodeId: id, reason: 'unchanged' });
          continue;
        }

        node.addVersion(
          {
            payload: result.payload,
            authorship: 'system',
            upstream: currentUpstreamOf(graph, id),
          },
          rt,
        );
        const version = node.requireCurrent();
        changedVersions.set(id, version.id);
        causesByNode.set(id, [upstreamRef(id, version.id)]);
        recomputed.push(id);

        const staleness = node.markStale('updated', causes, at);
        if (staleness) flagged.push({ nodeId: id, staleness });
        continue;
      }
    }

    const kind: StalenessKind = change.nature === 'structure' ? 'needsReview' : 'outOfDate';
    const staleness = node.markStale(kind, causes, at);
    if (staleness) {
      flagged.push({ nodeId: id, staleness });
    } else {
      skipped.push({ nodeId: id, reason: 'acknowledged' });
    }
  }

  return {
    origin: change,
    affected,
    recomputed,
    flagged,
    skipped,
    suppressedByLifecycle: false,
  };
}

/**
 * Attributes a node's staleness to specific upstream versions.
 *
 * A direct dependency that genuinely produced a new version is cited directly. One
 * that was only *flagged* did not actually change, so citing it would be misleading —
 * its own causes are inherited instead, and the blame traces back to the real origin.
 * Topological ordering guarantees those causes are already resolved.
 */
function resolveCauses(
  graph: ProjectGraph,
  id: NodeId,
  change: ChangeEvent,
  affectedSet: ReadonlySet<NodeId>,
  changedVersions: ReadonlyMap<NodeId, VersionId>,
  causesByNode: ReadonlyMap<NodeId, readonly UpstreamRef[]>,
): readonly UpstreamRef[] {
  const collected = new Map<string, UpstreamRef>();

  for (const depId of graph.dependenciesOf(id)) {
    const isInvolved = depId === change.nodeId || affectedSet.has(depId);
    if (!isInvolved) continue;

    const newVersion = changedVersions.get(depId);
    const refs = newVersion
      ? [upstreamRef(depId, newVersion)]
      : (causesByNode.get(depId) ?? []);

    for (const ref of refs) collected.set(`${ref.nodeId}@${ref.versionId}`, ref);
  }

  return [...collected.values()];
}

/** Every node currently asking something of the user, in dependency-safe order. */
export function needsAttention(graph: ProjectGraph): readonly ArtifactNode[] {
  return graph
    .topoOrder()
    .map((id) => graph.require(id))
    .filter((node) => node.needsAttention);
}

/** Clears a node's flag without spending compute (PRD §5.3 step 4). */
export function acknowledge(graph: ProjectGraph, id: NodeId): boolean {
  return graph.require(id).acknowledgeStale();
}

/** Bulk "approve all, flag exceptions" — the default posture resolved from §11 Q3. */
export function acknowledgeAll(graph: ProjectGraph, ids: readonly NodeId[]): readonly NodeId[] {
  return ids.filter((id) => graph.require(id).acknowledgeStale());
}
