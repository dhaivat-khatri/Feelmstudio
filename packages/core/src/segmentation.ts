import { type SceneId, sceneId as toSceneId } from './ids.js';
import type { Runtime } from './runtime.js';
import { containment, jaccard, sameText, tokenSet } from './text.js';

/**
 * Scene identity across a script rewrite.
 *
 * This is the case the PRD's staleness model does not cover and the most likely way
 * the non-destructive promise breaks. When Maya edits her script and it is
 * re-segmented, 19 scenes may become 18, or scene 4 may split in two. That is not
 * staleness — it is *identity loss*, and it is silently destructive if the system
 * simply renumbers: scene 5's generated video would quietly become scene 6's.
 *
 * So scenes carry stable ids that survive rewrites, and re-segmentation is never
 * applied silently. `diffSegmentation` computes a reviewable proposal; applying it is
 * a separate, explicit act.
 */

export interface Segment {
  readonly id: SceneId;
  /** 1-based display order. */
  readonly ordinal: number;
  readonly text: string;
  readonly heading?: string;
}

export type Segmentation = readonly Segment[];

/** An incoming boundary proposal — text only, identity not yet assigned. */
export interface ProposedSegment {
  readonly text: string;
  readonly heading?: string;
}

export interface MatchedScene {
  readonly sceneId: SceneId;
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  readonly similarity: number;
  readonly textChanged: boolean;
  /**
   * True when identity was inferred from position rather than from the words — a
   * scene rewritten so heavily that nothing matches, but which still sits in the same
   * slot between the same unchanged neighbours. Keeping the identity is the less
   * destructive reading, but it is a guess, so these always require review.
   */
  readonly positional: boolean;
}

export interface SplitScene {
  readonly from: SceneId;
  readonly into: readonly SceneId[];
  /** The child that keeps the original identity, so its media is not orphaned. */
  readonly inherited: SceneId;
}

export interface MergedScene {
  readonly from: readonly SceneId[];
  readonly into: SceneId;
  /** The source whose identity the merged scene keeps. */
  readonly inherited: SceneId;
}

/** Many-to-many restructuring that is not cleanly a split or a merge. */
export interface RestructuredGroup {
  readonly from: readonly SceneId[];
  readonly into: readonly SceneId[];
}

export interface SegmentationDiff {
  /** The proposed segmentation with identity assigned. Not yet applied. */
  readonly next: Segmentation;
  readonly matched: readonly MatchedScene[];
  readonly splits: readonly SplitScene[];
  readonly merges: readonly MergedScene[];
  readonly restructured: readonly RestructuredGroup[];
  readonly added: readonly SceneId[];
  readonly removed: readonly SceneId[];
  /** True when a human has to look before this can be applied. */
  readonly requiresReview: boolean;
  readonly summary: string;
}

export interface DiffOptions {
  /** Jaccard overlap above which two segments are considered the same scene. */
  readonly matchThreshold?: number;
  /** Containment above which one segment is considered a piece of another. */
  readonly containmentThreshold?: number;
}

const DEFAULT_MATCH = 0.5;
const DEFAULT_CONTAINMENT = 0.7;

export const newSegmentation = (
  proposed: readonly ProposedSegment[],
  rt: Runtime,
): Segmentation =>
  proposed.map((segment, index) => ({
    id: toSceneId(rt.ids.next('scene')),
    ordinal: index + 1,
    text: segment.text,
    ...(segment.heading !== undefined && { heading: segment.heading }),
  }));

/**
 * Matches a proposed segmentation against the current one and classifies what moved.
 *
 * Matching is done over a bipartite relation (old scenes to new segments) built from
 * symmetric similarity plus asymmetric containment in both directions. Connected
 * components of that relation classify themselves: one-to-one is a match, one-to-many
 * a split, many-to-one a merge, many-to-many a restructure a human must resolve.
 */
export function diffSegmentation(
  current: Segmentation,
  proposed: readonly ProposedSegment[],
  rt: Runtime,
  options: DiffOptions = {},
): SegmentationDiff {
  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH;
  const containmentThreshold = options.containmentThreshold ?? DEFAULT_CONTAINMENT;

  const oldTokens = current.map((s) => tokenSet(s.text));
  const newTokens = proposed.map((s) => tokenSet(s.text));

  const similarity = (i: number, j: number): number =>
    jaccard(oldTokens[i] as ReadonlySet<string>, newTokens[j] as ReadonlySet<string>);

  // --- bipartite relation -----------------------------------------------------
  const related: Array<Set<number>> = current.map(() => new Set<number>());
  for (let i = 0; i < current.length; i += 1) {
    for (let j = 0; j < proposed.length; j += 1) {
      const oldSet = oldTokens[i] as ReadonlySet<string>;
      const newSet = newTokens[j] as ReadonlySet<string>;
      const isSame = similarity(i, j) >= matchThreshold;
      const newIsPieceOfOld = containment(newSet, oldSet) >= containmentThreshold;
      const oldIsPieceOfNew = containment(oldSet, newSet) >= containmentThreshold;
      if (isSame || newIsPieceOfOld || oldIsPieceOfNew) related[i]?.add(j);
    }
  }

  // --- connected components ---------------------------------------------------
  const components = connectedComponents(current.length, proposed.length, related);

  // --- classify ---------------------------------------------------------------
  const assignedIds = new Array<SceneId | undefined>(proposed.length).fill(undefined);
  const matched: MatchedScene[] = [];
  const splits: SplitScene[] = [];
  const merges: MergedScene[] = [];
  const restructured: RestructuredGroup[] = [];
  const added: SceneId[] = [];
  const removed: SceneId[] = [];

  const freshId = (): SceneId => toSceneId(rt.ids.next('scene'));
  const sceneAt = (i: number): Segment => current[i] as Segment;

  // Deferred until after the positional pass — a scene with no textual match is not
  // necessarily gone, it may just have been rewritten where it stands.
  const pendingOld: number[] = [];
  const pendingNew: number[] = [];
  const anchors: Array<{ old: number; new: number }> = [];

  for (const { olds, news } of components) {
    if (olds.length === 0) {
      pendingNew.push(...news);
      continue;
    }

    if (news.length === 0) {
      pendingOld.push(...olds);
      continue;
    }

    anchors.push({ old: Math.min(...olds), new: Math.min(...news) });

    if (olds.length === 1 && news.length === 1) {
      const i = olds[0] as number;
      const j = news[0] as number;
      const scene = sceneAt(i);
      assignedIds[j] = scene.id;
      matched.push({
        sceneId: scene.id,
        fromOrdinal: scene.ordinal,
        toOrdinal: j + 1,
        similarity: similarity(i, j),
        textChanged: !sameText(scene.text, proposed[j]?.text ?? ''),
        positional: false,
      });
      continue;
    }

    if (olds.length === 1) {
      // One scene became several. The closest child keeps the identity so the
      // original's generated media stays attached to something rather than orphaned.
      const i = olds[0] as number;
      const scene = sceneAt(i);
      const best = news.reduce((a, b) => (similarity(i, b) > similarity(i, a) ? b : a));
      const into: SceneId[] = [];
      for (const j of news) {
        const id = j === best ? scene.id : freshId();
        assignedIds[j] = id;
        into.push(id);
      }
      splits.push({ from: scene.id, into, inherited: scene.id });
      continue;
    }

    if (news.length === 1) {
      // Several scenes became one. The largest contributor keeps its identity.
      const j = news[0] as number;
      const best = olds.reduce((a, b) => (similarity(b, j) > similarity(a, j) ? b : a));
      const inherited = sceneAt(best).id;
      assignedIds[j] = inherited;
      merges.push({ from: olds.map((i) => sceneAt(i).id), into: inherited, inherited });
      continue;
    }

    // Many-to-many: pair off greedily by similarity, then surface the rest as-is.
    const pairs: Array<{ i: number; j: number; score: number }> = [];
    for (const i of olds) for (const j of news) pairs.push({ i, j, score: similarity(i, j) });
    pairs.sort((a, b) => b.score - a.score);

    const usedOld = new Set<number>();
    const usedNew = new Set<number>();
    for (const { i, j } of pairs) {
      if (usedOld.has(i) || usedNew.has(j)) continue;
      usedOld.add(i);
      usedNew.add(j);
      assignedIds[j] = sceneAt(i).id;
    }
    for (const j of news) if (assignedIds[j] === undefined) assignedIds[j] = freshId();

    restructured.push({
      from: olds.map((i) => sceneAt(i).id),
      into: news.map((j) => assignedIds[j] as SceneId),
    });
  }

  // Positional rescue, then whatever is genuinely new or genuinely gone.
  const rescued = pairAcrossGaps(anchors, pendingOld, pendingNew, current.length, proposed.length);
  for (const { old: i, new: j } of rescued) {
    const scene = sceneAt(i);
    assignedIds[j] = scene.id;
    matched.push({
      sceneId: scene.id,
      fromOrdinal: scene.ordinal,
      toOrdinal: j + 1,
      similarity: similarity(i, j),
      textChanged: true,
      positional: true,
    });
  }

  const rescuedOld = new Set(rescued.map((p) => p.old));
  const rescuedNew = new Set(rescued.map((p) => p.new));
  for (const j of pendingNew) {
    if (rescuedNew.has(j)) continue;
    const id = freshId();
    assignedIds[j] = id;
    added.push(id);
  }
  for (const i of pendingOld) {
    if (!rescuedOld.has(i)) removed.push(sceneAt(i).id);
  }

  const next: Segmentation = proposed.map((segment, index) => ({
    id: assignedIds[index] ?? freshId(),
    ordinal: index + 1,
    text: segment.text,
    ...(segment.heading !== undefined && { heading: segment.heading }),
  }));

  const reordered = matched.filter((m) => m.fromOrdinal !== m.toOrdinal);
  const requiresReview =
    splits.length > 0 ||
    merges.length > 0 ||
    restructured.length > 0 ||
    added.length > 0 ||
    removed.length > 0 ||
    reordered.length > 0 ||
    matched.some((m) => m.positional);

  return {
    next,
    matched,
    splits,
    merges,
    restructured,
    added,
    removed,
    requiresReview,
    summary: summarize({ matched, splits, merges, restructured, added, removed, reordered }),
  };
}

/** Scenes whose ordinal changed while keeping their identity. */
export const movedScenes = (diff: SegmentationDiff): readonly MatchedScene[] =>
  diff.matched.filter((m) => m.fromOrdinal !== m.toOrdinal);

/**
 * Scenes whose generated media no longer matches the script. Callers turn these into
 * staleness — 'outOfDate' for a plain text change, 'needsReview' where identity moved.
 */
export function scenesNeedingRegeneration(diff: SegmentationDiff): readonly SceneId[] {
  const ids = new Set<SceneId>();
  for (const m of diff.matched) if (m.textChanged) ids.add(m.sceneId);
  for (const s of diff.splits) for (const id of s.into) ids.add(id);
  for (const m of diff.merges) ids.add(m.into);
  for (const r of diff.restructured) for (const id of r.into) ids.add(id);
  return [...ids];
}

/** Scenes whose identity moved — these need a human, not just a regeneration. */
export function scenesNeedingReview(diff: SegmentationDiff): readonly SceneId[] {
  const ids = new Set<SceneId>();
  for (const s of diff.splits) for (const id of s.into) ids.add(id);
  for (const m of diff.merges) ids.add(m.into);
  for (const r of diff.restructured) for (const id of r.into) ids.add(id);
  for (const m of movedScenes(diff)) ids.add(m.sceneId);
  for (const m of diff.matched) if (m.positional) ids.add(m.sceneId);
  return [...ids];
}

/**
 * Pairs leftover scenes with leftover segments that occupy the same slot between the
 * same two confident anchors.
 *
 * This is what rescues "Maya rewrote scene 2 from scratch": nothing in the words
 * matches, but it still sits between an unchanged scene 1 and an unchanged scene 3,
 * so it is the same scene rather than a deletion plus an unrelated insertion. The gap
 * constraint keeps it honest — a scene deleted in one place and another added
 * somewhere else entirely fall into different gaps and are never paired.
 */
function pairAcrossGaps(
  anchors: ReadonlyArray<{ old: number; new: number }>,
  pendingOld: readonly number[],
  pendingNew: readonly number[],
  oldCount: number,
  newCount: number,
): ReadonlyArray<{ old: number; new: number }> {
  if (pendingOld.length === 0 || pendingNew.length === 0) return [];

  const ordered = [...anchors].sort((a, b) => a.old - b.old);
  const bounds: Array<{ oldLo: number; oldHi: number; newLo: number; newHi: number }> = [];

  let prevOld = -1;
  let prevNew = -1;
  for (const anchor of ordered) {
    bounds.push({
      oldLo: prevOld + 1,
      oldHi: anchor.old - 1,
      newLo: prevNew + 1,
      newHi: anchor.new - 1,
    });
    prevOld = anchor.old;
    prevNew = anchor.new;
  }
  bounds.push({ oldLo: prevOld + 1, oldHi: oldCount - 1, newLo: prevNew + 1, newHi: newCount - 1 });

  const availableOld = new Set(pendingOld);
  const availableNew = new Set(pendingNew);
  const pairs: Array<{ old: number; new: number }> = [];

  for (const bound of bounds) {
    const olds = [...availableOld].filter((i) => i >= bound.oldLo && i <= bound.oldHi).sort((a, b) => a - b);
    const news = [...availableNew].filter((j) => j >= bound.newLo && j <= bound.newHi).sort((a, b) => a - b);

    for (let k = 0; k < Math.min(olds.length, news.length); k += 1) {
      const old = olds[k] as number;
      const next = news[k] as number;
      pairs.push({ old, new: next });
      availableOld.delete(old);
      availableNew.delete(next);
    }
  }

  return pairs;
}

// --- internals ----------------------------------------------------------------

interface Component {
  readonly olds: readonly number[];
  readonly news: readonly number[];
}

function connectedComponents(
  oldCount: number,
  newCount: number,
  related: ReadonlyArray<ReadonlySet<number>>,
): readonly Component[] {
  const newToOld: Array<Set<number>> = Array.from({ length: newCount }, () => new Set<number>());
  for (let i = 0; i < oldCount; i += 1) {
    for (const j of related[i] ?? []) newToOld[j]?.add(i);
  }

  const seenOld = new Set<number>();
  const seenNew = new Set<number>();
  const components: Component[] = [];

  const explore = (startOld: number | null, startNew: number | null): Component => {
    const olds: number[] = [];
    const news: number[] = [];
    const queue: Array<['o' | 'n', number]> = [];

    if (startOld !== null) queue.push(['o', startOld]);
    if (startNew !== null) queue.push(['n', startNew]);

    while (queue.length > 0) {
      const [side, index] = queue.shift() as ['o' | 'n', number];
      if (side === 'o') {
        if (seenOld.has(index)) continue;
        seenOld.add(index);
        olds.push(index);
        for (const j of related[index] ?? []) if (!seenNew.has(j)) queue.push(['n', j]);
      } else {
        if (seenNew.has(index)) continue;
        seenNew.add(index);
        news.push(index);
        for (const i of newToOld[index] ?? []) if (!seenOld.has(i)) queue.push(['o', i]);
      }
    }

    // Sorted so output order follows the script, not traversal order.
    return { olds: olds.sort((a, b) => a - b), news: news.sort((a, b) => a - b) };
  };

  for (let i = 0; i < oldCount; i += 1) {
    if (!seenOld.has(i)) components.push(explore(i, null));
  }
  for (let j = 0; j < newCount; j += 1) {
    if (!seenNew.has(j)) components.push(explore(null, j));
  }

  return components;
}

function summarize(parts: {
  matched: readonly MatchedScene[];
  splits: readonly SplitScene[];
  merges: readonly MergedScene[];
  restructured: readonly RestructuredGroup[];
  added: readonly SceneId[];
  removed: readonly SceneId[];
  reordered: readonly MatchedScene[];
}): string {
  const bits: string[] = [];
  const edited = parts.matched.filter((m) => m.textChanged).length;
  const unchanged = parts.matched.length - edited;

  if (unchanged > 0) bits.push(`${unchanged} unchanged`);
  if (edited > 0) bits.push(`${edited} edited`);
  if (parts.reordered.length > 0) bits.push(`${parts.reordered.length} reordered`);
  if (parts.splits.length > 0) bits.push(`${parts.splits.length} split`);
  if (parts.merges.length > 0) bits.push(`${parts.merges.length} merged`);
  if (parts.restructured.length > 0) bits.push(`${parts.restructured.length} restructured`);
  if (parts.added.length > 0) bits.push(`${parts.added.length} added`);
  if (parts.removed.length > 0) bits.push(`${parts.removed.length} removed`);

  return bits.length > 0 ? bits.join(', ') : 'no changes';
}
