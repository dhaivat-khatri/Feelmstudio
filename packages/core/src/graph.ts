import { CycleError, DuplicateNodeError, IllegalDependencyError, NodeNotFoundError } from './errors.js';
import type { NodeId, SceneId } from './ids.js';
import { isRootKind, type NodeKind } from './kinds.js';
import { ArtifactNode, type ArtifactNodeInit, type ArtifactNodeSnapshot } from './node.js';

/**
 * Plain-JSON snapshot of a graph's full state: every node plus the dependency edges
 * (dependent -> dependency; dependents are the mirror and are rebuilt from these).
 */
export interface ProjectGraphSnapshot {
  readonly nodes: readonly ArtifactNodeSnapshot[];
  readonly dependencies: ReadonlyArray<readonly [dependent: NodeId, dependency: NodeId]>;
}

/**
 * The project as an explicit dependency graph (PRD §5.1).
 *
 * Edge direction convention, fixed once here because getting it backwards is the
 * classic source of bugs in this shape of code:
 *
 *     dependency  ──▶  dependent          data flows left to right
 *     (Character)      (Scene image)      the image depends on the character
 *
 * Staleness propagation always walks *dependents*. Provenance always walks
 * *dependencies*. Nothing else in the package should touch the adjacency maps.
 */
export class ProjectGraph {
  private readonly _nodes = new Map<NodeId, ArtifactNode>();
  /** node -> the nodes it depends on */
  private readonly _dependencies = new Map<NodeId, Set<NodeId>>();
  /** node -> the nodes that depend on it */
  private readonly _dependents = new Map<NodeId, Set<NodeId>>();

  // --- nodes ------------------------------------------------------------------

  get size(): number {
    return this._nodes.size;
  }

  get nodes(): readonly ArtifactNode[] {
    return [...this._nodes.values()];
  }

  get nodeIds(): readonly NodeId[] {
    return [...this._nodes.keys()];
  }

  has(id: NodeId): boolean {
    return this._nodes.has(id);
  }

  get(id: NodeId): ArtifactNode | undefined {
    return this._nodes.get(id);
  }

  require(id: NodeId): ArtifactNode {
    const node = this._nodes.get(id);
    if (!node) throw new NodeNotFoundError(id);
    return node;
  }

  /** Typed accessor for callers that know a node's payload shape. */
  requireAs<P>(id: NodeId): ArtifactNode<P> {
    return this.require(id) as ArtifactNode<P>;
  }

  addNode<P = unknown>(init: ArtifactNodeInit): ArtifactNode<P> {
    if (this._nodes.has(init.id)) throw new DuplicateNodeError(init.id);
    const node = new ArtifactNode<P>(init);
    this._nodes.set(init.id, node as ArtifactNode);
    this._dependencies.set(init.id, new Set());
    this._dependents.set(init.id, new Set());
    return node;
  }

  removeNode(id: NodeId): void {
    this.require(id);
    for (const dep of this._dependencies.get(id) ?? []) this._dependents.get(dep)?.delete(id);
    for (const dep of this._dependents.get(id) ?? []) this._dependencies.get(dep)?.delete(id);
    this._dependencies.delete(id);
    this._dependents.delete(id);
    this._nodes.delete(id);
  }

  nodesOfKind(kind: NodeKind): readonly ArtifactNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }

  nodesOfScene(scene: SceneId): readonly ArtifactNode[] {
    return this.nodes.filter((n) => n.sceneId === scene);
  }

  // --- edges ------------------------------------------------------------------

  /**
   * Records that `dependentId` depends on `dependencyId`. Rejects self-edges, edges
   * into root kinds (imported user media can never be invalidated by the pipeline),
   * and anything that would close a cycle. Idempotent.
   */
  addDependency(dependentId: NodeId, dependencyId: NodeId): void {
    const dependent = this.require(dependentId);
    this.require(dependencyId);

    if (dependentId === dependencyId) {
      throw new IllegalDependencyError(`Node "${dependentId}" cannot depend on itself.`);
    }
    if (isRootKind(dependent.kind)) {
      throw new IllegalDependencyError(
        `"${dependent.label}" is a ${dependent.kind} node, which is a source and cannot depend on anything.`,
      );
    }

    const existing = this._dependencies.get(dependentId);
    if (existing?.has(dependencyId)) return;

    const backPath = this.findPath(dependentId, dependencyId, this._dependents);
    if (backPath) throw new CycleError([...backPath, dependentId]);

    existing?.add(dependencyId);
    this._dependents.get(dependencyId)?.add(dependentId);
  }

  removeDependency(dependentId: NodeId, dependencyId: NodeId): void {
    this._dependencies.get(dependentId)?.delete(dependencyId);
    this._dependents.get(dependencyId)?.delete(dependentId);
  }

  dependenciesOf(id: NodeId): readonly NodeId[] {
    this.require(id);
    return [...(this._dependencies.get(id) ?? [])];
  }

  dependentsOf(id: NodeId): readonly NodeId[] {
    this.require(id);
    return [...(this._dependents.get(id) ?? [])];
  }

  // --- traversal --------------------------------------------------------------

  /**
   * Everything affected by a change to `id`, excluding `id` itself, in an order where
   * every node appears after all of its own dependencies.
   *
   * This ordering is what makes propagation correct rather than merely plausible: a
   * scene video is visited only once its scene plan has already been recomputed, so
   * it sees the plan's new version rather than the stale one.
   */
  transitiveDependents(id: NodeId): readonly NodeId[] {
    return this.orderTopologically(this.reachable(id, this._dependents));
  }

  /** Everything `id` was built from, transitively. */
  transitiveDependencies(id: NodeId): readonly NodeId[] {
    return this.orderTopologically(this.reachable(id, this._dependencies));
  }

  /** Dependencies before dependents, across the whole graph. */
  topoOrder(): readonly NodeId[] {
    const indegree = new Map<NodeId, number>();
    for (const id of this._nodes.keys()) {
      indegree.set(id, this._dependencies.get(id)?.size ?? 0);
    }

    const queue: NodeId[] = [];
    for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

    const ordered: NodeId[] = [];
    while (queue.length > 0) {
      const id = queue.shift() as NodeId;
      ordered.push(id);
      for (const dependent of this._dependents.get(id) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) queue.push(dependent);
      }
    }

    // addDependency rejects cycles, so this is a structural invariant, not a runtime path.
    if (ordered.length !== this._nodes.size) {
      throw new CycleError([], 'Project graph contains a cycle; this should be impossible.');
    }
    return ordered;
  }

  // --- internals --------------------------------------------------------------

  private reachable(from: NodeId, edges: Map<NodeId, Set<NodeId>>): Set<NodeId> {
    this.require(from);
    const seen = new Set<NodeId>();
    const queue: NodeId[] = [...(edges.get(from) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift() as NodeId;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of edges.get(id) ?? []) if (!seen.has(next)) queue.push(next);
    }
    return seen;
  }

  private orderTopologically(subset: Set<NodeId>): readonly NodeId[] {
    if (subset.size === 0) return [];
    return this.topoOrder().filter((id) => subset.has(id));
  }

  // --- persistence --------------------------------------------------------------

  toSnapshot(): ProjectGraphSnapshot {
    const dependencies: Array<readonly [NodeId, NodeId]> = [];
    for (const [dependentId, deps] of this._dependencies) {
      for (const dependencyId of deps) dependencies.push([dependentId, dependencyId]);
    }
    return { nodes: this.nodes.map((n) => n.toSnapshot()), dependencies };
  }

  /**
   * Rebuilds a graph from a snapshot, restoring edges directly rather than replaying
   * `addDependency` — the data was already validated once, before it was saved, and
   * re-running the cycle/root-kind checks here would only pay their cost for nothing.
   */
  static fromSnapshot(snapshot: ProjectGraphSnapshot): ProjectGraph {
    const graph = new ProjectGraph();
    for (const nodeSnapshot of snapshot.nodes) {
      const node = ArtifactNode.fromSnapshot(nodeSnapshot);
      graph._nodes.set(node.id, node);
      graph._dependencies.set(node.id, new Set());
      graph._dependents.set(node.id, new Set());
    }
    for (const [dependentId, dependencyId] of snapshot.dependencies) {
      graph._dependencies.get(dependentId)?.add(dependencyId);
      graph._dependents.get(dependencyId)?.add(dependentId);
    }
    return graph;
  }

  /** Shortest path from `from` to `to` along `edges`, or null. Used for cycle messages. */
  private findPath(
    from: NodeId,
    to: NodeId,
    edges: Map<NodeId, Set<NodeId>>,
  ): readonly NodeId[] | null {
    if (from === to) return [from];
    const previous = new Map<NodeId, NodeId>();
    const seen = new Set<NodeId>([from]);
    const queue: NodeId[] = [from];

    while (queue.length > 0) {
      const id = queue.shift() as NodeId;
      for (const next of edges.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        previous.set(next, id);
        if (next === to) {
          const path: NodeId[] = [to];
          let cursor: NodeId | undefined = to;
          while ((cursor = previous.get(cursor)) !== undefined) path.unshift(cursor);
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  }
}
