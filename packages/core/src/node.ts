import { NoCurrentVersionError, VersionNotFoundError } from './errors.js';
import { type NodeId, type SceneId, versionId as toVersionId } from './ids.js';
import { type NodeKind, type Materiality, specOf } from './kinds.js';
import type { Runtime } from './runtime.js';
import type { NewVersionInput, Provenance, UpstreamRef, Version } from './version.js';

/** The status chip shown on every scene card and pipeline tab (PRD §8). */
export type NodeStatus =
  | 'notStarted'
  | 'queued'
  | 'generating'
  | 'needsReview'
  | 'approved'
  | 'failed';

/**
 * "Stale" in the PRD is one word doing three jobs, which is why §10 already worries
 * users won't understand it. Split into three states with distinct user meaning:
 *
 *   'updated'     Auto-resolved. Cheap derived text already caught up. Informational
 *                 only — nothing is asked of the user.
 *   'outOfDate'   Generated media no longer matches its inputs. Left untouched and
 *                 playable; regenerating is the user's explicit call.
 *   'needsReview' Structure moved underneath this node (e.g. re-segmentation changed
 *                 which scene this belongs to). A human has to look.
 */
export type StalenessKind = 'updated' | 'outOfDate' | 'needsReview';

const SEVERITY: Record<StalenessKind, number> = {
  updated: 0,
  outOfDate: 1,
  needsReview: 2,
};

export interface Staleness {
  readonly kind: StalenessKind;
  /** Exactly which upstream versions caused this. Drives "what changed?" in the UI. */
  readonly causes: readonly UpstreamRef[];
  readonly since: string;
}

export interface NodeFailure {
  readonly code: string;
  readonly message: string;
  readonly at: string;
  readonly retryable: boolean;
}

export interface ArtifactNodeInit {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly label?: string;
  readonly sceneId?: SceneId;
}

/**
 * Plain-JSON snapshot of a node's full state, for persistence. Deliberately mirrors
 * the private fields exactly rather than the public API, because reconstructing state
 * like the acknowledged map or a `notStarted` status is not reachable by replaying
 * public mutators — `acknowledgeStale()` requires a live staleness to clear.
 */
export interface ArtifactNodeSnapshot<P = unknown> {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly label: string;
  readonly sceneId?: SceneId;
  readonly versions: readonly Version<P>[];
  readonly currentIndex: number;
  readonly status: NodeStatus;
  readonly staleness: Staleness | null;
  readonly failure: NodeFailure | null;
  /** Map serialized as entries; JSON has no Map type. */
  readonly acknowledged: ReadonlyArray<readonly [NodeId, string]>;
}

export class ArtifactNode<P = unknown> {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly materiality: Materiality;
  readonly sceneId: SceneId | undefined;
  label: string;

  private _versions: Version<P>[] = [];
  private _currentIndex = -1;
  private _status: NodeStatus = 'notStarted';
  private _staleness: Staleness | null = null;
  private _failure: NodeFailure | null = null;
  /** Upstream versions the user has explicitly accepted as-is (PRD §5.3 step 4). */
  private _acknowledged = new Map<NodeId, string>();

  constructor(init: ArtifactNodeInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.materiality = specOf(init.kind).materiality;
    this.label = init.label ?? specOf(init.kind).label;
    this.sceneId = init.sceneId;
  }

  // --- versions ---------------------------------------------------------------

  get versions(): readonly Version<P>[] {
    return this._versions;
  }

  get versionCount(): number {
    return this._versions.length;
  }

  get hasVersions(): boolean {
    return this._currentIndex >= 0;
  }

  /** Current version, or undefined if nothing has been generated yet. */
  get current(): Version<P> | undefined {
    return this._currentIndex >= 0 ? this._versions[this._currentIndex] : undefined;
  }

  /** Current version, throwing if absent. Use where a version is a precondition. */
  requireCurrent(): Version<P> {
    const v = this.current;
    if (!v) throw new NoCurrentVersionError(this.id);
    return v;
  }

  versionById(id: string): Version<P> | undefined {
    return this._versions.find((v) => v.id === id);
  }

  /**
   * Appends a new version and makes it current. Never overwrites — this is what makes
   * "regenerate scene 2" safe to do casually (PRD §5.2). Producing a new version also
   * resolves any staleness, since the node has now caught up with its inputs.
   */
  addVersion(input: NewVersionInput<P>, rt: Runtime): Version<P> {
    const provenance: Provenance = {
      authorship: input.authorship,
      upstream: input.upstream ? [...input.upstream] : [],
      ...(input.prompt !== undefined && { prompt: input.prompt }),
      ...(input.seed !== undefined && { seed: input.seed }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.restoredFrom !== undefined && { restoredFrom: input.restoredFrom }),
      ...(input.rerollOf !== undefined && { rerollOf: input.rerollOf }),
    };

    const version: Version<P> = {
      id: toVersionId(rt.ids.next('v')),
      index: this._versions.length + 1,
      createdAt: rt.clock.now(),
      payload: input.payload,
      provenance,
    };

    this._versions.push(version);
    this._currentIndex = this._versions.length - 1;
    this._staleness = null;
    this._acknowledged.clear();
    this._failure = null;
    if (this._status === 'failed' || this._status === 'generating' || this._status === 'queued') {
      this._status = 'needsReview';
    }
    return version;
  }

  /**
   * Restore is additive, not a rewind: it appends a copy of the old payload as a new
   * version. Nothing is ever lost, including the version being restored away from.
   */
  restore(id: string, rt: Runtime): Version<P> {
    const target = this.versionById(id);
    if (!target) throw new VersionNotFoundError(id);
    return this.addVersion(
      {
        payload: target.payload,
        authorship: 'user',
        upstream: target.provenance.upstream,
        restoredFrom: target.id,
        ...(target.provenance.prompt !== undefined && { prompt: target.provenance.prompt }),
        ...(target.provenance.seed !== undefined && { seed: target.provenance.seed }),
        ...(target.provenance.model !== undefined && { model: target.provenance.model }),
      },
      rt,
    );
  }

  // --- status -----------------------------------------------------------------

  get status(): NodeStatus {
    return this._status;
  }

  setStatus(status: NodeStatus): void {
    this._status = status;
    if (status !== 'failed') this._failure = null;
  }

  get failure(): NodeFailure | null {
    return this._failure;
  }

  fail(failure: Omit<NodeFailure, 'at'>, rt: Runtime): void {
    this._status = 'failed';
    this._failure = { ...failure, at: rt.clock.now() };
  }

  approve(): void {
    this._status = 'approved';
  }

  // --- staleness --------------------------------------------------------------

  get staleness(): Staleness | null {
    return this._staleness;
  }

  get isStale(): boolean {
    return this._staleness !== null;
  }

  /** True when the node is flagged in a way that actually asks something of the user. */
  get needsAttention(): boolean {
    if (this._status === 'failed' || this._status === 'needsReview') return true;
    return this._staleness !== null && this._staleness.kind !== 'updated';
  }

  /**
   * A 'derived' node is only safe to recompute automatically while it remains
   * system-authored. Once a user has edited it, an automatic recompute would destroy
   * their work, so it is treated exactly like generated media: flagged, not touched.
   */
  get isAutoRecomputable(): boolean {
    if (this.materiality !== 'derived') return false;
    const current = this.current;
    return current === undefined || current.provenance.authorship === 'system';
  }

  /**
   * Flags this node, ignoring any cause the user already accepted as-is. Merges with
   * existing staleness, keeping the most severe kind and the union of causes, so a
   * second unrelated change never erases the first one's explanation.
   *
   * Returns the resulting staleness, or null when every cause was already acknowledged.
   */
  markStale(kind: StalenessKind, causes: readonly UpstreamRef[], at: string): Staleness | null {
    const unacknowledged = causes.filter((c) => this._acknowledged.get(c.nodeId) !== c.versionId);
    if (unacknowledged.length === 0) return this._staleness;

    const previous = this._staleness;
    if (!previous) {
      this._staleness = { kind, causes: unacknowledged, since: at };
      return this._staleness;
    }

    const merged = new Map<string, UpstreamRef>();
    for (const c of [...previous.causes, ...unacknowledged]) merged.set(`${c.nodeId}@${c.versionId}`, c);

    this._staleness = {
      kind: SEVERITY[kind] > SEVERITY[previous.kind] ? kind : previous.kind,
      causes: [...merged.values()],
      since: previous.since,
    };
    return this._staleness;
  }

  /**
   * "Approve as-is" (PRD §5.3 step 4): clears the flag in one action without spending
   * any compute. The accepted upstream versions are remembered, so this exact change
   * never nags again — but a *later* change to the same upstream will flag afresh,
   * because the recorded version id won't match.
   */
  acknowledgeStale(): boolean {
    const staleness = this._staleness;
    if (!staleness) return false;
    for (const cause of staleness.causes) this._acknowledged.set(cause.nodeId, cause.versionId);
    this._staleness = null;
    return true;
  }

  /** Upstream versions this node has been told to stop worrying about. */
  get acknowledged(): ReadonlyMap<NodeId, string> {
    return this._acknowledged;
  }

  clearStaleness(): void {
    this._staleness = null;
  }

  // --- persistence --------------------------------------------------------------

  toSnapshot(): ArtifactNodeSnapshot<P> {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      ...(this.sceneId !== undefined && { sceneId: this.sceneId }),
      versions: this._versions,
      currentIndex: this._currentIndex,
      status: this._status,
      staleness: this._staleness,
      failure: this._failure,
      acknowledged: [...this._acknowledged.entries()],
    };
  }

  /** Reconstructs a node exactly as it was, bypassing the public mutators entirely. */
  static fromSnapshot<P>(snapshot: ArtifactNodeSnapshot<P>): ArtifactNode<P> {
    const node = new ArtifactNode<P>({
      id: snapshot.id,
      kind: snapshot.kind,
      label: snapshot.label,
      ...(snapshot.sceneId !== undefined && { sceneId: snapshot.sceneId }),
    });
    node._versions = [...snapshot.versions];
    node._currentIndex = snapshot.currentIndex;
    node._status = snapshot.status;
    node._staleness = snapshot.staleness;
    node._failure = snapshot.failure;
    node._acknowledged = new Map(snapshot.acknowledged);
    return node;
  }
}
