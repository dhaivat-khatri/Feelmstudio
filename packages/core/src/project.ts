import { agentStatusOf, type PersonaRole } from './agents.js';
import { ProjectGraph, type ProjectGraphSnapshot } from './graph.js';
import { NoteBoard, type CrewNote, type NoteInput } from './notes.js';
import { DeliberationLog, type RoomEntry, type RoomEntryInput } from './deliberation.js';
import { type NodeId, nodeId, type ProjectId, type SceneId } from './ids.js';
import { acceptsStalenessFlags, type ProjectLifecycle } from './lifecycle.js';
import type { ArtifactNode, NodeFailure, NodeStatus, StalenessKind } from './node.js';
import type { Runtime } from './runtime.js';
import {
  diffSegmentation,
  newSegmentation,
  scenesNeedingReview,
  type ProposedSegment,
  type Segmentation,
  type SegmentationDiff,
} from './segmentation.js';
import {
  currentUpstreamOf,
  propagate,
  type PropagationReport,
  type Recomputer,
} from './staleness.js';
import { upstreamRef, type Authorship, type Version } from './version.js';

export const SCRIPT_NODE = nodeId('script');
export const TIMELINE_NODE = nodeId('timeline');
export const STYLE_NODE = nodeId('style');
export const SUBTITLES_NODE = nodeId('subtitles');
export const MUSIC_NODE = nodeId('music');

/** Per-scene node naming. Deterministic and readable, so ids are debuggable. */
export type ScenePart = 'text' | 'plan' | 'image' | 'video' | 'narration';
export const scenePartNode = (scene: SceneId, part: ScenePart): NodeId =>
  nodeId(`${scene}:${part}`);

const MEDIA_PARTS: readonly ScenePart[] = ['plan', 'image', 'video', 'narration'];
const ALL_PARTS: readonly ScenePart[] = ['text', 'plan', 'image', 'video', 'narration'];

/** Worst-first, for rolling a scene's nodes up into one card chip. */
const STATUS_PRECEDENCE: readonly NodeStatus[] = [
  'failed',
  'generating',
  'queued',
  'needsReview',
  'notStarted',
  'approved',
];

export interface ScriptPayload {
  readonly segments: readonly string[];
}

/**
 * The Director's brief — the Production Bible (PRD-facing name: "style"). Read by
 * every scene's plan. The original four fields are always present (seeded at project
 * creation); the rest populate once the Director agent has actually run — absent on
 * the cheap system seed, same convention as ScenePlanPayload's shotType/framing.
 */
export interface StylePayload {
  readonly tone: string;
  readonly palette: string;
  readonly pacing: string;
  readonly mood: string;
  readonly format?: string;
  readonly genre?: string;
  readonly runtimeMinutes?: number;
  readonly characters?: readonly string[];
  readonly locations?: readonly string[];
  /** A one-shot visual continuity note (main character look, wardrobe, setting, film stock)
   *  prepended to every scene's image prompt so scenes read as one film. */
  readonly visualAnchor?: string;
}

/**
 * The Composer's music brief — genre/instrumentation/tempo/mood for the score, read
 * from the Director's style brief (its one graph dependency). Same convention as
 * StylePayload: the base fields are always present (cheap system seed); `direction`
 * only populates once the Composer agent has actually run.
 */
export interface MusicPayload {
  readonly genre: string;
  readonly instrumentation: string;
  readonly tempo: string;
  readonly mood: string;
  readonly direction?: string;
  /**
   * Filename of a rendered soundtrack clip, once the Composer's brief has been
   * sent to a music model (see the server's `/music/render`). Absent until then —
   * the brief stands on its own.
   */
  readonly trackFile?: string;
}

export interface ScenePlanPayload {
  readonly sceneId: SceneId;
  readonly ordinal: number;
  readonly text: string;
  /** Populated once the Cinematographer has run; absent on the cheap system seed. */
  readonly shotType?: string;
  readonly framing?: string;
  readonly cameraMove?: string;
  readonly durationSeconds?: number;
}

export interface TimelinePayload {
  readonly order: readonly SceneId[];
}

export interface SubtitleCue {
  readonly sceneId: SceneId;
  readonly ordinal: number;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * Subtitles are a pure derivation of the approved script (Journey A, F6) — never a
 * re-transcription of narration audio, since ASR mangles exactly the domain
 * vocabulary an educator cares most about getting right.
 *
 * Timing is a words-per-minute estimate over each scene's own text, not real audio
 * duration — narration doesn't carry a duration yet (its adapter is still the fake
 * one, see AppContext). Ceiling: cues can drift from actual narration pacing once
 * real audio exists. Upgrade path: prefer `narration`'s payload duration per scene
 * when the real speech adapter starts reporting one, falling back to this estimate
 * only where it doesn't.
 */
export interface SubtitlesPayload {
  readonly cues: readonly SubtitleCue[];
}

export interface SceneSummary {
  readonly sceneId: SceneId;
  readonly ordinal: number;
  readonly heading: string | undefined;
  readonly status: NodeStatus;
  readonly staleness: StalenessKind | null;
  readonly needsAttention: boolean;
}

export interface ProjectOverview {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly idea: string;
  readonly style: StylePayload;
  readonly music: MusicPayload;
  readonly agentStatus: Record<PersonaRole, NodeStatus>;
  /** The assembled cut. `manual: true` once a user has trimmed/reordered it —
   * see `Project.trimTimeline` — after which upstream scene changes flag it
   * stale instead of silently overwriting the trim. */
  readonly timeline: { readonly order: readonly SceneId[]; readonly manual: boolean };
  readonly lifecycle: ProjectLifecycle;
  readonly scenes: readonly SceneSummary[];
  readonly retiredScenes: readonly SceneId[];
  readonly needsAttention: readonly NodeId[];
  readonly counts: Readonly<Record<NodeStatus, number>>;
  /** Crew coordination notes (dailies + production meeting), newest first. */
  readonly notes: readonly CrewNote[];
  readonly openNoteCount: number;
  /** How many scene-deliberation entries the project has (the Rooms tab badge). */
  readonly roomEntryCount: number;
}

export interface ScriptRevision {
  readonly version: Version<ScriptPayload>;
  /** A proposal. Nothing downstream moves until `applySegmentation` is called. */
  readonly diff: SegmentationDiff;
}

export interface ProjectInit {
  readonly id: ProjectId;
  readonly title: string;
  readonly idea?: string;
  readonly lifecycle?: ProjectLifecycle;
}

/** Plain-JSON snapshot of a project's full state, for persistence. */
export interface ProjectSnapshot {
  readonly id: ProjectId;
  readonly title: string;
  readonly idea: string;
  readonly lifecycle: ProjectLifecycle;
  readonly segmentation: Segmentation;
  readonly retired: readonly SceneId[];
  readonly graph: ProjectGraphSnapshot;
  /** Crew coordination notes (dailies + production meeting). Optional for back-compat. */
  readonly notes?: readonly CrewNote[];
  /** Scene deliberation entries (the Rooms tab). Optional for back-compat. */
  readonly rooms?: readonly RoomEntry[];
}

/**
 * The project aggregate: assembles the pipeline into a real graph and exposes the
 * operations the app layer needs, without letting it touch adjacency directly.
 *
 * Two invariants everything here preserves:
 *   - Regeneration is always explicit. Nothing in this class spends inference compute.
 *   - Re-segmentation is never applied silently. `editScript` proposes; a separate
 *     `applySegmentation` commits.
 */
export class Project {
  readonly id: ProjectId;
  readonly graph = new ProjectGraph();
  title: string;
  idea: string;
  lifecycle: ProjectLifecycle;

  private _segmentation: Segmentation = [];
  private readonly _retired: SceneId[] = [];
  private _notes = new NoteBoard();
  private _rooms = new DeliberationLog();

  /**
   * `hydrate`, when given, is a previously-saved snapshot: the graph, segmentation and
   * retired list are restored from it directly instead of being built fresh, so a
   * reloaded project resumes exactly where it was saved rather than replaying setup
   * that would mint a second default style version.
   */
  constructor(
    init: ProjectInit,
    private readonly rt: Runtime,
    hydrate?: ProjectSnapshot,
  ) {
    this.id = init.id;
    this.title = init.title;
    this.idea = init.idea ?? '';
    this.lifecycle = init.lifecycle ?? 'draft';

    if (hydrate) {
      this.graph = ProjectGraph.fromSnapshot(hydrate.graph);
      this._segmentation = hydrate.segmentation;
      this._retired = [...hydrate.retired];
      this._notes = NoteBoard.fromSnapshot(hydrate.notes);
      this._rooms = DeliberationLog.fromSnapshot(hydrate.rooms);
      this.idea = hydrate.idea;
      // Migration: projects saved before MUSIC_NODE existed won't have it in their
      // restored graph snapshot — add it lazily so old projects still work.
      if (!this.graph.has(MUSIC_NODE)) this.seedMusicNode();
      return;
    }

    this.graph.addNode({ id: SCRIPT_NODE, kind: 'script' });
    this.graph.addNode({ id: STYLE_NODE, kind: 'style' });
    this.graph.addNode({ id: TIMELINE_NODE, kind: 'timeline' });
    this.graph.addNode({ id: SUBTITLES_NODE, kind: 'subtitles' });

    // A project always has a style, so scene media has something to cite as
    // provenance from the first generation onward. Real content comes from the
    // Director (POST /projects/:id/style/generate); this is the cheap system seed.
    this.graph.require(STYLE_NODE).addVersion(
      {
        payload: { tone: 'neutral', palette: 'natural', pacing: 'even', mood: 'plain' } satisfies StylePayload,
        authorship: 'system',
      },
      this.rt,
    );

    this.seedMusicNode();
  }

  /** Adds MUSIC_NODE (depends on style, like scenePlan) with its cheap system seed. */
  private seedMusicNode(): void {
    this.graph.addNode({ id: MUSIC_NODE, kind: 'music' });
    this.graph.addDependency(MUSIC_NODE, STYLE_NODE);
    this.graph.require(MUSIC_NODE).addVersion(
      {
        payload: { genre: 'none', instrumentation: 'none', tempo: 'even', mood: 'plain' } satisfies MusicPayload,
        authorship: 'system',
      },
      this.rt,
    );
  }

  get segmentation(): Segmentation {
    return this._segmentation;
  }

  /** Scenes cut from the script. Their media is kept, just no longer assembled. */
  get retiredScenes(): readonly SceneId[] {
    return this._retired;
  }

  get sceneIds(): readonly SceneId[] {
    return this._segmentation.map((s) => s.id);
  }

  // --- script and segmentation -------------------------------------------------

  /**
   * First segmentation. There is no prior work to lose, so this applies directly.
   * Serves both Maya's "paste script" entry and the generated-script path.
   */
  initializeFromScript(segments: readonly ProposedSegment[], authorship: Authorship = 'user'): void {
    if (this._segmentation.length > 0) {
      throw new Error('Project already has a segmentation; use editScript instead.');
    }

    this._segmentation = newSegmentation(segments, this.rt);
    this.scriptNode.addVersion(
      { payload: { segments: segments.map((s) => s.text) }, authorship },
      this.rt,
    );

    for (const segment of this._segmentation) this.buildScene(segment.id);
    this.seedDerived();
  }

  /**
   * Commits the user's new script text and returns a *proposed* re-segmentation.
   *
   * The script edit itself is the user's own work and lands immediately. What the
   * boundaries become is a proposal, because re-segmentation can move scene identity —
   * and identity moving silently is how generated media gets attached to the wrong
   * scene. Call `applySegmentation` to commit it.
   */
  editScript(
    segments: readonly ProposedSegment[],
    authorship: Authorship = 'user',
  ): ScriptRevision {
    const version = this.scriptNode.addVersion(
      { payload: { segments: segments.map((s) => s.text) }, authorship },
      this.rt,
    );
    const diff = diffSegmentation(this._segmentation, segments, this.rt);
    return { version, diff };
  }

  /**
   * Commits a reviewed segmentation proposal.
   *
   * Runs in two passes. First a precise content propagation, which re-derives every
   * scene's slice and prunes the ones that did not move — so an edit to one scene
   * leaves the rest untouched. Then structural review flags, applied only to the
   * scenes whose identity actually shifted.
   */
  applySegmentation(diff: SegmentationDiff): PropagationReport {
    const surviving = new Set(diff.next.map((s) => s.id));

    for (const sceneId of diff.added) this.buildScene(sceneId);
    for (const group of [...diff.splits, ...diff.restructured]) {
      for (const sceneId of group.into) if (!this.graph.has(scenePartNode(sceneId, 'text'))) {
        this.buildScene(sceneId);
      }
    }
    for (const sceneId of diff.removed) this.retireScene(sceneId);
    for (const merge of diff.merges) {
      for (const sceneId of merge.from) if (!surviving.has(sceneId)) this.retireScene(sceneId);
    }

    this._segmentation = diff.next;

    const scriptVersion = this.scriptNode.requireCurrent();
    const report = propagate(
      this.graph,
      { nodeId: SCRIPT_NODE, versionId: scriptVersion.id, nature: 'content' },
      this.rt,
      { lifecycle: this.lifecycle, recompute: this.recomputer },
    );

    // Structural review is targeted, not blanket. Escalating every dependent to
    // needsReview would re-introduce exactly the over-flagging the graph exists to
    // avoid — only scenes whose identity moved need a human.
    //
    // Lifecycle gates this pass too: a published project must stay silent no matter
    // which route the flag would have arrived by.
    if (acceptsStalenessFlags(this.lifecycle)) {
      const cause = [upstreamRef(SCRIPT_NODE, scriptVersion.id)];
      const at = this.rt.clock.now();
      for (const sceneId of scenesNeedingReview(diff)) {
        for (const part of MEDIA_PARTS) {
          const node = this.graph.get(scenePartNode(sceneId, part));
          if (node?.hasVersions) node.markStale('needsReview', cause, at);
        }
      }
    }

    return report;
  }

  // --- regeneration -------------------------------------------------------------

  /**
   * Records a regenerated artifact and propagates. Spending the compute is the
   * caller's job; this only records the result.
   */
  recordGeneration(
    id: NodeId,
    payload: unknown,
    options: { prompt?: string; seed?: number; model?: string } = {},
  ): PropagationReport {
    const node = this.graph.require(id);
    const version = node.addVersion(
      {
        payload,
        authorship: 'system',
        upstream: currentUpstreamOf(this.graph, id),
        ...(options.prompt !== undefined && { prompt: options.prompt }),
        ...(options.seed !== undefined && { seed: options.seed }),
        ...(options.model !== undefined && { model: options.model }),
      },
      this.rt,
    );

    // A fresh generation is review-worthy. `addVersion` already flips
    // failed/queued/generating → needsReview; a media node that was still
    // `notStarted` (its job never touched the node status, only the job record)
    // needs the same nudge, or the scene grid shows "not started" forever after
    // a successful generate.
    if (node.status === 'notStarted') node.setStatus('needsReview');

    return propagate(
      this.graph,
      { nodeId: id, versionId: version.id, nature: 'content' },
      this.rt,
      { lifecycle: this.lifecycle, recompute: this.recomputer },
    );
  }

  /** Records a failed generation. Project owns the clock, so callers can't reach it. */
  fail(id: NodeId, failure: Omit<NodeFailure, 'at'>): void {
    this.graph.require(id).fail(failure, this.rt);
  }

  /** Records a user's direct edit of an artifact, then propagates. */
  recordEdit(id: NodeId, payload: unknown): PropagationReport {
    const node = this.graph.require(id);
    const version = node.addVersion(
      { payload, authorship: 'user', upstream: currentUpstreamOf(this.graph, id) },
      this.rt,
    );
    return propagate(
      this.graph,
      { nodeId: id, versionId: version.id, nature: 'content' },
      this.rt,
      { lifecycle: this.lifecycle, recompute: this.recomputer },
    );
  }

  // --- approval -----------------------------------------------------------------

  /** Approve-as-is for a whole scene: clears flags without spending any compute. */
  acknowledgeScene(scene: SceneId): number {
    let cleared = 0;
    for (const part of ALL_PARTS) {
      const node = this.graph.get(scenePartNode(scene, part));
      if (node?.acknowledgeStale()) cleared += 1;
    }
    return cleared;
  }

  /** The resolved §11 Q3 default: approve everything, leaving exceptions flagged. */
  approveAll(): number {
    let approved = 0;
    for (const node of this.graph.nodes) {
      if (node.hasVersions && node.status !== 'failed' && !node.isStale) {
        node.approve();
        approved += 1;
      }
    }
    return approved;
  }

  // --- reporting ----------------------------------------------------------------

  sceneSummary(scene: SceneId): SceneSummary | undefined {
    const segment = this._segmentation.find((s) => s.id === scene);
    if (!segment) return undefined;

    const nodes = ALL_PARTS.flatMap((part) => {
      const node = this.graph.get(scenePartNode(scene, part));
      return node ? [node] : [];
    });

    const status =
      STATUS_PRECEDENCE.find((candidate) => nodes.some((n) => n.status === candidate)) ??
      'notStarted';

    const staleness = nodes
      .map((n) => n.staleness?.kind)
      .find((kind): kind is StalenessKind => kind !== undefined && kind !== 'updated');

    return {
      sceneId: scene,
      ordinal: segment.ordinal,
      heading: segment.heading,
      status,
      staleness: staleness ?? null,
      needsAttention: nodes.some((n) => n.needsAttention),
    };
  }

  /** Everything the Project Overview tab and Scenes grid need, in one read. */
  overview(): ProjectOverview {
    const counts: Record<NodeStatus, number> = {
      notStarted: 0,
      queued: 0,
      generating: 0,
      needsReview: 0,
      approved: 0,
      failed: 0,
    };
    for (const node of this.graph.nodes) counts[node.status] += 1;

    return {
      projectId: this.id,
      title: this.title,
      idea: this.idea,
      style: this.graph.require(STYLE_NODE).current!.payload as StylePayload,
      music: this.graph.require(MUSIC_NODE).current!.payload as MusicPayload,
      agentStatus: agentStatusOf(this),
      timeline: {
        order: (this.graph.get(TIMELINE_NODE)?.current?.payload as TimelinePayload | undefined)?.order ?? this.sceneIds,
        manual: !(this.graph.get(TIMELINE_NODE)?.isAutoRecomputable ?? true),
      },
      lifecycle: this.lifecycle,
      scenes: this._segmentation.flatMap((s) => {
        const summary = this.sceneSummary(s.id);
        return summary ? [summary] : [];
      }),
      retiredScenes: [...this._retired],
      needsAttention: this.graph
        .topoOrder()
        .filter((id) => this.graph.require(id).needsAttention),
      counts,
      notes: [...this._notes.all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      openNoteCount: this._notes.openCount,
      roomEntryCount: this._rooms.all.length,
    };
  }

  // --- persistence ----------------------------------------------------------------

  toSnapshot(): ProjectSnapshot {
    return {
      id: this.id,
      title: this.title,
      idea: this.idea,
      lifecycle: this.lifecycle,
      segmentation: this._segmentation,
      retired: [...this._retired],
      graph: this.graph.toSnapshot(),
      notes: this._notes.toSnapshot(),
      rooms: this._rooms.toSnapshot(),
    };
  }

  // --- crew coordination notes (dailies + production meeting) --------------------

  /** Every note ever issued, open and addressed. */
  get notes(): readonly CrewNote[] {
    return this._notes.all;
  }

  /** Issue a note from one crew role to another (optionally scene-scoped). */
  addNote(input: NoteInput): CrewNote {
    return this._notes.add(input, this.rt);
  }

  /**
   * Open notes an agent should fold into its next regeneration — its own
   * scene-scoped notes plus whole-project notes. `role` is the persona; pass the
   * scene id for a per-scene agent (Cinematographer), omit for a whole-project
   * one (Writer, Composer).
   */
  openNotesFor(role: PersonaRole, sceneId?: SceneId): CrewNote[] {
    return this._notes.openFor(role, sceneId);
  }

  /** Mark notes addressed, optionally linking the version that did it (decision log). */
  addressNotes(ids: readonly string[], byVersionId?: string): void {
    this._notes.address(ids, this.rt, byVersionId);
  }

  // --- deliberation rooms (the Rooms tab) ---------------------------------------

  get rooms(): readonly RoomEntry[] {
    return this._rooms.all;
  }

  /** Append a batch of room entries from one scene deliberation. */
  addRoomEntries(inputs: readonly RoomEntryInput[]): RoomEntry[] {
    return this._rooms.addMany(inputs, this.rt);
  }

  /** Every room entry authored by, or addressed to, one persona. */
  roomEntriesFor(role: PersonaRole): RoomEntry[] {
    return this._rooms.forRole(role);
  }

  static fromSnapshot(snapshot: ProjectSnapshot, rt: Runtime): Project {
    return new Project(
      { id: snapshot.id, title: snapshot.title, idea: snapshot.idea, lifecycle: snapshot.lifecycle },
      rt,
      snapshot,
    );
  }

  // --- internals ----------------------------------------------------------------

  private get scriptNode(): ArtifactNode<ScriptPayload> {
    return this.graph.requireAs<ScriptPayload>(SCRIPT_NODE);
  }

  /**
   * Wires one scene's slice of the pipeline.
   *
   * The `text` node is the important one: it isolates a scene from the whole-script
   * blast radius. Media depends on the slice, never on the script directly, so an
   * edit elsewhere in the script prunes at this node and never reaches the pixels.
   */
  private buildScene(scene: SceneId): void {
    const text = scenePartNode(scene, 'text');
    const plan = scenePartNode(scene, 'plan');
    const image = scenePartNode(scene, 'image');
    const video = scenePartNode(scene, 'video');
    const narration = scenePartNode(scene, 'narration');

    this.graph.addNode({ id: text, kind: 'sceneScript', sceneId: scene });
    this.graph.addNode({ id: plan, kind: 'scenePlan', sceneId: scene });
    this.graph.addNode({ id: image, kind: 'sceneImage', sceneId: scene });
    this.graph.addNode({ id: video, kind: 'sceneVideo', sceneId: scene });
    this.graph.addNode({ id: narration, kind: 'narration', sceneId: scene });

    this.graph.addDependency(text, SCRIPT_NODE);
    this.graph.addDependency(plan, text);
    this.graph.addDependency(plan, STYLE_NODE);
    this.graph.addDependency(image, plan);
    this.graph.addDependency(video, image);
    this.graph.addDependency(video, plan);
    this.graph.addDependency(narration, text);
    this.graph.addDependency(TIMELINE_NODE, video);
    this.graph.addDependency(TIMELINE_NODE, narration);
    this.graph.addDependency(SUBTITLES_NODE, text);
  }

  /**
   * Detaches a cut scene from the timeline. The nodes and their whole version history
   * stay in the graph — a scene leaving the script must not destroy hours of
   * generated work, in case the user puts it back.
   */
  private retireScene(scene: SceneId): void {
    this.graph.removeDependency(TIMELINE_NODE, scenePartNode(scene, 'video'));
    this.graph.removeDependency(TIMELINE_NODE, scenePartNode(scene, 'narration'));
    this.graph.removeDependency(SUBTITLES_NODE, scenePartNode(scene, 'text'));
    if (!this._retired.includes(scene)) this._retired.push(scene);
  }

  /**
   * The Editor's manual override of the assembled cut: reorder scenes, or leave
   * one out of the final sequence without retiring it from the script (that's
   * `retireScene` — a separate, permanent action; a trimmed-out scene keeps its
   * generated media and can be brought back by trimming again).
   *
   * Delegates to `recordEdit` — the existing generic "user hand-edits a node"
   * path (already covered by the "protecting hand edits" test) — rather than
   * reimplementing it: `recordEdit` is what actually propagates the change and
   * records correct `upstream` provenance, on top of the user-authored version
   * that flips `ArtifactNode.isAutoRecomputable` to false so a later scene
   * change flags the timeline stale instead of silently overwriting the trim.
   */
  trimTimeline(order: readonly SceneId[]): PropagationReport {
    const valid = new Set(this.sceneIds);
    const seen = new Set<SceneId>();
    for (const id of order) {
      if (!valid.has(id)) throw new Error(`Not a scene in this project: "${id}"`);
      if (seen.has(id)) throw new Error(`Duplicate scene in timeline order: "${id}"`);
      seen.add(id);
    }
    return this.recordEdit(TIMELINE_NODE, { order } satisfies TimelinePayload);
  }

  /**
   * Reverts to auto-assembly (full segmentation order, system-authored) — undoes
   * `trimTimeline`. Can't go through `recordEdit` (it hardcodes `authorship:
   * 'user'`), so this mirrors its propagate + upstream-provenance logic directly
   * with `authorship: 'system'` instead.
   */
  resetTimeline(): PropagationReport {
    const version = this.graph.require(TIMELINE_NODE).addVersion(
      {
        payload: { order: this.sceneIds } satisfies TimelinePayload,
        authorship: 'system',
        upstream: currentUpstreamOf(this.graph, TIMELINE_NODE),
      },
      this.rt,
    );
    return propagate(
      this.graph,
      { nodeId: TIMELINE_NODE, versionId: version.id, nature: 'content' },
      this.rt,
      { lifecycle: this.lifecycle, recompute: this.recomputer },
    );
  }

  /** Gives the derived nodes their initial system-authored content. */
  private seedDerived(): void {
    for (const segment of this._segmentation) {
      const text = this.graph.require(scenePartNode(segment.id, 'text'));
      text.addVersion(
        {
          payload: segment.text,
          authorship: 'system',
          upstream: currentUpstreamOf(this.graph, text.id),
        },
        this.rt,
      );

      const plan = this.graph.require(scenePartNode(segment.id, 'plan'));
      plan.addVersion(
        {
          payload: this.planFor(segment.id) satisfies ScenePlanPayload | null,
          authorship: 'system',
          upstream: currentUpstreamOf(this.graph, plan.id),
        },
        this.rt,
      );
    }

    const timeline = this.graph.require(TIMELINE_NODE);
    timeline.addVersion(
      {
        payload: { order: this.sceneIds } satisfies TimelinePayload,
        authorship: 'system',
        upstream: currentUpstreamOf(this.graph, TIMELINE_NODE),
      },
      this.rt,
    );

    const subtitles = this.graph.require(SUBTITLES_NODE);
    subtitles.addVersion(
      {
        payload: this.computeSubtitles(),
        authorship: 'system',
        upstream: currentUpstreamOf(this.graph, SUBTITLES_NODE),
      },
      this.rt,
    );
  }

  /** Words-per-minute pacing estimate — see SubtitlesPayload's ceiling/upgrade note. */
  private computeSubtitles(): SubtitlesPayload {
    const WORDS_PER_MINUTE = 150;
    const MIN_DURATION_SECONDS = 1.5;
    let cursor = 0;
    const cues: SubtitleCue[] = this._segmentation.map((segment) => {
      const wordCount = segment.text.trim().split(/\s+/).filter(Boolean).length;
      const duration = Math.max((wordCount / WORDS_PER_MINUTE) * 60, MIN_DURATION_SECONDS);
      const cue: SubtitleCue = {
        sceneId: segment.id,
        ordinal: segment.ordinal,
        text: segment.text,
        startSeconds: cursor,
        endSeconds: cursor + duration,
      };
      cursor += duration;
      return cue;
    });
    return { cues };
  }

  private planFor(scene: SceneId): ScenePlanPayload | null {
    const segment = this._segmentation.find((s) => s.id === scene);
    return segment
      ? { sceneId: scene, ordinal: segment.ordinal, text: segment.text }
      : null;
  }

  /**
   * Re-derives the cheap nodes. Returning identical content is what prunes a branch,
   * so these must be pure functions of the current segmentation.
   */
  private readonly recomputer: Recomputer = ({ node }) => {
    switch (node.kind) {
      case 'sceneScript': {
        const segment = this._segmentation.find((s) => s.id === node.sceneId);
        return segment ? { payload: segment.text } : null;
      }
      case 'timeline':
        return { payload: { order: this.sceneIds } satisfies TimelinePayload };
      case 'subtitles':
        return { payload: this.computeSubtitles() };
      default:
        return null;
    }
  };
}
