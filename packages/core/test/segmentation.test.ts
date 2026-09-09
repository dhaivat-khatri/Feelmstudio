import { describe, expect, it } from 'vitest';

import {
  diffSegmentation,
  movedScenes,
  newSegmentation,
  scenesNeedingRegeneration,
  scenesNeedingReview,
  type ProposedSegment,
  type Segmentation,
} from '../src/segmentation.js';
import { rt } from './helpers.js';

// A slice of Maya's finance explainer. Distinct vocabulary per scene, as real script
// prose has — the matcher relies on that rather than on position.
const S1 = 'Compound interest is the single most powerful force in personal finance.';
const S2 = 'Imagine you invest one thousand dollars at seven percent annual return.';
const S3 = 'After ten years that thousand becomes nearly two thousand dollars.';
const S4 = 'The lesson is simple: start early and let time do the work for you.';

const propose = (...texts: string[]): ProposedSegment[] => texts.map((text) => ({ text }));

function baseline(): { current: Segmentation; runtime: ReturnType<typeof rt> } {
  const runtime = rt();
  return { current: newSegmentation(propose(S1, S2, S3, S4), runtime), runtime };
}

const idsOf = (segmentation: Segmentation) => segmentation.map((s) => s.id);

describe('newSegmentation', () => {
  it('assigns stable ids and 1-based ordinals', () => {
    const segmentation = newSegmentation(propose(S1, S2), rt());

    expect(segmentation.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(new Set(idsOf(segmentation)).size).toBe(2);
    expect(segmentation[0]?.text).toBe(S1);
  });
});

describe('diffSegmentation — no structural change', () => {
  it('reports an identical segmentation as unchanged and safe to apply', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, propose(S1, S2, S3, S4), runtime);

    expect(diff.requiresReview).toBe(false);
    expect(diff.matched).toHaveLength(4);
    expect(diff.matched.every((m) => !m.textChanged)).toBe(true);
    expect(idsOf(diff.next)).toEqual(idsOf(current));
    expect(diff.summary).toBe('4 unchanged');
    expect(scenesNeedingRegeneration(diff)).toEqual([]);
  });

  it('treats reflowed whitespace as unchanged', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, propose(S1, `  ${S2}\n\n`, S3, S4), runtime);

    expect(diff.matched.every((m) => !m.textChanged)).toBe(true);
    expect(diff.requiresReview).toBe(false);
  });

  /** Maya's most common edit: fix two sentences, keep the structure. */
  it('keeps identity when a scene is rewritten in place', () => {
    const { current, runtime } = baseline();
    const rewritten = 'Imagine you invest one thousand dollars at eight percent annual return.';

    const diff = diffSegmentation(current, propose(S1, rewritten, S3, S4), runtime);

    expect(diff.requiresReview).toBe(false);
    expect(idsOf(diff.next)).toEqual(idsOf(current));

    const scene2 = diff.matched.find((m) => m.sceneId === current[1]?.id);
    expect(scene2?.textChanged).toBe(true);
    expect(scenesNeedingRegeneration(diff)).toEqual([current[1]?.id]);
    // A plain content edit needs regeneration, not a structural review.
    expect(scenesNeedingReview(diff)).toEqual([]);
  });

  it('does not mutate the current segmentation', () => {
    const { current, runtime } = baseline();
    const snapshot = JSON.parse(JSON.stringify(current));

    diffSegmentation(current, propose(S1, S3), runtime);

    expect(JSON.parse(JSON.stringify(current))).toEqual(snapshot);
  });
});

describe('diffSegmentation — splits', () => {
  it('detects one scene becoming two and hands identity to the closest child', () => {
    const { current, runtime } = baseline();
    const firstHalf = 'Imagine you invest one thousand dollars';
    const secondHalf = 'at seven percent annual return';

    const diff = diffSegmentation(current, propose(S1, firstHalf, secondHalf, S3, S4), runtime);

    expect(diff.splits).toHaveLength(1);
    const split = diff.splits[0];
    expect(split?.from).toBe(current[1]?.id);
    expect(split?.into).toHaveLength(2);
    // The original identity survives on one child rather than being orphaned.
    expect(split?.into).toContain(current[1]?.id);
    expect(split?.inherited).toBe(current[1]?.id);
    expect(diff.requiresReview).toBe(true);
  });

  it('leaves untouched scenes alone through a split', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(
      current,
      propose(S1, 'Imagine you invest one thousand dollars', 'at seven percent annual return', S3, S4),
      runtime,
    );

    expect(diff.next[0]?.id).toBe(current[0]?.id);
    expect(diff.next[3]?.id).toBe(current[2]?.id);
    expect(diff.next[4]?.id).toBe(current[3]?.id);
    expect(diff.next.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('diffSegmentation — merges', () => {
  it('detects two scenes collapsing into one', () => {
    const { current, runtime } = baseline();
    const combined = `${S2} ${S3}`;

    const diff = diffSegmentation(current, propose(S1, combined, S4), runtime);

    expect(diff.merges).toHaveLength(1);
    const merge = diff.merges[0];
    expect(merge?.from).toEqual([current[1]?.id, current[2]?.id]);
    expect(merge?.into).toBe(current[1]?.id);
    expect(diff.requiresReview).toBe(true);
    expect(scenesNeedingReview(diff)).toContain(current[1]?.id);
  });
});

describe('diffSegmentation — additions and removals', () => {
  it('assigns a fresh id to genuinely new material', () => {
    const { current, runtime } = baseline();
    const brandNew = 'Taxes and inflation quietly erode nominal gains every single year.';

    const diff = diffSegmentation(current, propose(S1, S2, brandNew, S3, S4), runtime);

    expect(diff.added).toHaveLength(1);
    expect(idsOf(current)).not.toContain(diff.added[0]);
    expect(diff.next[2]?.id).toBe(diff.added[0]);
    expect(diff.requiresReview).toBe(true);
  });

  it('reports a deleted scene as removed', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, propose(S1, S3, S4), runtime);

    expect(diff.removed).toEqual([current[1]?.id]);
    expect(diff.added).toEqual([]);
  });

  /**
   * The exact failure this module exists to prevent: after deleting scene 2, a naive
   * renumbering would hand scene 3's generated video to what is now scene 2.
   */
  it('does not slide identity down when an earlier scene is deleted', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, propose(S1, S3, S4), runtime);

    expect(idsOf(diff.next)).toEqual([current[0]?.id, current[2]?.id, current[3]?.id]);
    expect(diff.next[1]?.ordinal).toBe(2);
    expect(diff.next[1]?.text).toBe(S3);
  });

  it('treats an empty proposal as removing everything', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, [], runtime);

    expect(diff.removed).toEqual(idsOf(current));
    expect(diff.next).toEqual([]);
    expect(diff.summary).toBe('4 removed');
  });

  it('treats a first segmentation as all additions', () => {
    const runtime = rt();

    const diff = diffSegmentation([], propose(S1, S2), runtime);

    expect(diff.added).toHaveLength(2);
    expect(diff.matched).toEqual([]);
    expect(idsOf(diff.next)).toEqual(diff.added);
  });
});

describe('diffSegmentation — reordering', () => {
  it('keeps identity through a reorder and still asks for review', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, propose(S1, S3, S2, S4), runtime);

    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(idsOf(diff.next)).toEqual([
      current[0]?.id,
      current[2]?.id,
      current[1]?.id,
      current[3]?.id,
    ]);

    const moved = movedScenes(diff);
    expect(moved.map((m) => m.sceneId).sort()).toEqual(
      [current[1]?.id, current[2]?.id].sort(),
    );
    expect(diff.requiresReview).toBe(true);
    // Reordering changes nothing about the pixels, so nothing needs regenerating.
    expect(scenesNeedingRegeneration(diff)).toEqual([]);
    expect(scenesNeedingReview(diff)).toHaveLength(2);
  });
});

describe('diffSegmentation — positional rescue', () => {
  const REWRITTEN = 'Nothing whatsoever in common with the previous wording here.';

  /**
   * Maya rewrites a scene from scratch. Not one word matches, but it still sits
   * between an unchanged scene 1 and an unchanged scene 3 — so it is that scene,
   * rewritten, and its generated media must not be orphaned.
   */
  it('keeps identity for a scene rewritten in place between stable neighbours', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(current, propose(S1, REWRITTEN, S3, S4), runtime);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(idsOf(diff.next)).toEqual(idsOf(current));

    const rescued = diff.matched.find((m) => m.sceneId === current[1]?.id);
    expect(rescued?.positional).toBe(true);
    expect(rescued?.textChanged).toBe(true);
    // Identity was inferred from position, not content, so a human confirms it.
    expect(diff.requiresReview).toBe(true);
    expect(scenesNeedingReview(diff)).toContain(current[1]?.id);
  });

  /** The guard: a deletion here and an insertion there are not the same scene. */
  it('does not pair a deletion and an insertion in different slots', () => {
    const { current, runtime } = baseline();
    const brandNew = 'Taxes and inflation quietly erode nominal gains every single year.';

    // S2 deleted from the middle; unrelated new material appended at the end.
    const diff = diffSegmentation(current, propose(S1, S3, S4, brandNew), runtime);

    expect(diff.removed).toEqual([current[1]?.id]);
    expect(diff.added).toHaveLength(1);
    expect(diff.matched.every((m) => !m.positional)).toBe(true);
  });

  it('does not rescue across a scene that is still confidently matched', () => {
    const { current, runtime } = baseline();
    const brandNew = 'Taxes and inflation quietly erode nominal gains every single year.';

    // S4 removed from the end, new material inserted before S3.
    const diff = diffSegmentation(current, propose(S1, S2, brandNew, S3), runtime);

    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toEqual([current[3]?.id]);
  });

  it('marks a wholesale rewrite as positional across the board', () => {
    const { current, runtime } = baseline();

    const diff = diffSegmentation(
      current,
      propose('alpha bravo charlie', 'delta echo foxtrot', 'golf hotel india', 'juliet kilo lima'),
      runtime,
    );

    expect(idsOf(diff.next)).toEqual(idsOf(current));
    expect(diff.matched.every((m) => m.positional)).toBe(true);
    expect(diff.requiresReview).toBe(true);
  });
});

describe('diffSegmentation — summary', () => {
  it('describes a mixed change in one line', () => {
    const { current, runtime } = baseline();
    const brandNew = 'Taxes and inflation quietly erode nominal gains every single year.';

    const diff = diffSegmentation(current, propose(S1, S2, S4, brandNew), runtime);

    expect(diff.summary).toContain('added');
    expect(diff.summary).toContain('removed');
    expect(diff.requiresReview).toBe(true);
  });

  it('reports a clean run as no changes', () => {
    const runtime = rt();
    expect(diffSegmentation([], [], runtime).summary).toBe('no changes');
  });
});
