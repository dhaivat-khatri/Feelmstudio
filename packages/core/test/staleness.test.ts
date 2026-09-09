import { beforeEach, describe, expect, it } from 'vitest';

import type { ProjectGraph } from '../src/graph.js';
import type { NodeId } from '../src/ids.js';
import {
  acknowledge,
  acknowledgeAll,
  currentUpstreamOf,
  needsAttention,
  propagate,
} from '../src/staleness.js';
import type { Runtime } from '../src/runtime.js';
import {
  alwaysRecompute,
  contentChange,
  graphWith,
  id,
  names,
  rt,
  scene,
  seed,
  seedAll,
  structureChange,
} from './helpers.js';

/** A slice of the real pipeline: script -> per-scene plan -> image -> video -> timeline. */
function pipeline(): { graph: ProjectGraph; runtime: Runtime } {
  const graph = graphWith([
    ['script', 'script'],
    ['plan', 'sceneScript', { sceneId: scene('s1'), dependsOn: ['script'] }],
    ['image', 'sceneImage', { sceneId: scene('s1'), dependsOn: ['plan'] }],
    ['video', 'sceneVideo', { sceneId: scene('s1'), dependsOn: ['image'] }],
    ['timeline', 'timeline', { dependsOn: ['video'] }],
  ]);
  const runtime = rt();
  seedAll(graph, runtime, 'script', 'plan', 'image', 'video', 'timeline');
  return { graph, runtime };
}

const flaggedNames = (report: { flagged: readonly { nodeId: NodeId }[] }) =>
  report.flagged.map((f) => String(f.nodeId));

describe('propagate — the confirmed §5.3 contract', () => {
  let graph: ProjectGraph;
  let runtime: Runtime;

  beforeEach(() => {
    ({ graph, runtime } = pipeline());
  });

  it('flags downstream media as out of date without touching the media itself', () => {
    const video = graph.require(id('video'));
    const before = video.requireCurrent();

    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    const report = propagate(graph, contentChange('script', next), runtime);

    expect(video.staleness?.kind).toBe('outOfDate');
    // The whole promise: flagged, but the generated artifact is untouched and playable.
    expect(video.versionCount).toBe(1);
    expect(video.requireCurrent()).toBe(before);
    expect(report.recomputed).toEqual([]);
  });

  it('never regenerates on its own — no new versions appear anywhere downstream', () => {
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime);

    // Only the script itself gained a version, and that was the user's own edit.
    expect(graph.require(id('script')).versionCount).toBe(2);
    for (const name of ['plan', 'image', 'video', 'timeline']) {
      expect(graph.require(id(name)).versionCount).toBe(1);
    }
  });

  it('flags the full downstream chain, not just the first hop', () => {
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    const report = propagate(graph, contentChange('script', next), runtime);

    expect(names(report.affected)).toEqual(['plan', 'image', 'video', 'timeline']);
    expect(flaggedNames(report)).toEqual(['plan', 'image', 'video', 'timeline']);
  });

  it('recomputes cheap derived text automatically and marks it informational only', () => {
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    const report = propagate(graph, contentChange('script', next), runtime, {
      recompute: alwaysRecompute(),
    });

    const plan = graph.require(id('plan'));
    expect(names(report.recomputed)).toEqual(['plan', 'timeline']);
    expect(plan.versionCount).toBe(2);
    expect(plan.requireCurrent().payload).toBe('recomputed:plan');
    expect(plan.staleness?.kind).toBe('updated');
    // 'updated' resolved itself, so it must not compete for the user's attention.
    expect(plan.needsAttention).toBe(false);
  });

  it('falls back to out-of-date when the recomputer declines, rather than lying', () => {
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime, { recompute: () => null });

    const plan = graph.require(id('plan'));
    expect(plan.versionCount).toBe(1);
    expect(plan.staleness?.kind).toBe('outOfDate');
  });

  it('skips nodes that have never generated anything', () => {
    const bare = graphWith([
      ['script', 'script'],
      ['image', 'sceneImage', { dependsOn: ['script'] }],
    ]);
    const runtime2 = rt();
    const v = seed(bare, runtime2, 'script');

    const report = propagate(bare, contentChange('script', v), runtime2);

    expect(report.flagged).toEqual([]);
    expect(report.skipped).toEqual([{ nodeId: id('image'), reason: 'notStarted' }]);
    expect(bare.require(id('image')).isStale).toBe(false);
  });
});

describe('propagate — protecting user work', () => {
  /** Journey A, step 7: Maya spends 15 minutes trimming. An upstream edit must not undo it. */
  it('refuses to auto-recompute a derived node the user has hand-edited', () => {
    const { graph, runtime } = pipeline();
    const timeline = graph.require(id('timeline'));
    timeline.addVersion({ payload: 'hand-trimmed', authorship: 'user' }, runtime);

    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime, { recompute: alwaysRecompute() });

    expect(timeline.requireCurrent().payload).toBe('hand-trimmed');
    expect(timeline.staleness?.kind).toBe('outOfDate');
    expect(timeline.needsAttention).toBe(true);
  });

  it('still auto-recomputes a derived node that is untouched system output', () => {
    const { graph, runtime } = pipeline();

    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime, { recompute: alwaysRecompute() });

    expect(graph.require(id('timeline')).requireCurrent().payload).toBe('recomputed:timeline');
  });
});

describe('propagate — precision of blame', () => {
  /** PRD §5.1. Over-flagging is what erodes trust; this is the case it exists to prevent. */
  it('flags only the scenes that reference the changed character', () => {
    const graph = graphWith([
      ['john', 'character'],
      ['mary', 'character'],
      ['s1.img', 'sceneImage', { sceneId: scene('s1'), dependsOn: ['john'] }],
      ['s2.img', 'sceneImage', { sceneId: scene('s2'), dependsOn: ['mary'] }],
      ['s3.img', 'sceneImage', { sceneId: scene('s3'), dependsOn: ['john', 'mary'] }],
    ]);
    const runtime = rt();
    seedAll(graph, runtime, 'john', 'mary', 's1.img', 's2.img', 's3.img');

    const next = seed(graph, runtime, 'john', 'john in a red jacket', 'user');
    const report = propagate(graph, contentChange('john', next), runtime);

    // The traversal itself must be scoped. Asserting only on `flagged` would still
    // pass if we walked the whole project and filtered later — and "we considered
    // every node" is exactly the over-flagging §5.1 exists to rule out.
    expect(names(report.affected)).toEqual(['s1.img', 's3.img']);
    expect(report.skipped).toEqual([]);

    expect(flaggedNames(report)).toEqual(['s1.img', 's3.img']);
    expect(graph.require(id('s2.img')).isStale).toBe(false);
    expect(graph.require(id('mary')).isStale).toBe(false);
  });

  it('does not walk into unrelated branches of a wide project', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['music', 'music'],
      ['s1.plan', 'scenePlan', { sceneId: scene('s1'), dependsOn: ['script'] }],
      ['s2.plan', 'scenePlan', { sceneId: scene('s2'), dependsOn: ['script'] }],
      ['s1.img', 'sceneImage', { sceneId: scene('s1'), dependsOn: ['s1.plan'] }],
      ['s2.img', 'sceneImage', { sceneId: scene('s2'), dependsOn: ['s2.plan'] }],
    ]);
    const runtime = rt();
    seedAll(graph, runtime, 'script', 'music', 's1.plan', 's2.plan', 's1.img', 's2.img');

    const next = seed(graph, runtime, 'music', 'new bed', 'user');
    const report = propagate(graph, contentChange('music', next), runtime);

    expect(report.affected).toEqual([]);
    expect(report.flagged).toEqual([]);
    expect(needsAttention(graph)).toEqual([]);
  });

  it('cites the exact upstream version responsible', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');

    propagate(graph, contentChange('script', next), runtime);

    expect(graph.require(id('plan')).staleness?.causes).toEqual([
      { nodeId: id('script'), versionId: next.id },
    ]);
  });

  it('traces blame past an intermediate that was flagged but not regenerated', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');

    propagate(graph, contentChange('script', next), runtime);

    // The plan never actually changed, so citing it would misattribute the cause.
    expect(graph.require(id('video')).staleness?.causes).toEqual([
      { nodeId: id('script'), versionId: next.id },
    ]);
  });

  it('cites the intermediate itself once it really did produce a new version', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');

    propagate(graph, contentChange('script', next), runtime, { recompute: alwaysRecompute() });

    const planVersion = graph.require(id('plan')).requireCurrent();
    expect(graph.require(id('image')).staleness?.causes).toEqual([
      { nodeId: id('plan'), versionId: planVersion.id },
    ]);
  });

  it('unions causes and keeps the most severe kind across two separate changes', () => {
    const graph = graphWith([
      ['john', 'character'],
      ['style', 'style'],
      ['img', 'sceneImage', { dependsOn: ['john', 'style'] }],
    ]);
    const runtime = rt();
    seedAll(graph, runtime, 'john', 'style', 'img');

    const johnV2 = seed(graph, runtime, 'john', 'john v2', 'user');
    const first = propagate(graph, contentChange('john', johnV2), runtime);
    const firstSince = first.flagged[0]?.staleness.since;

    const styleV2 = seed(graph, runtime, 'style', 'style v2', 'user');
    const second = propagate(graph, structureChange('style', styleV2), runtime);

    const staleness = graph.require(id('img')).staleness;
    expect(staleness?.kind).toBe('needsReview');
    expect(staleness?.causes).toEqual([
      { nodeId: id('john'), versionId: johnV2.id },
      { nodeId: id('style'), versionId: styleV2.id },
    ]);
    // 'since' stays pinned to when the node *first* went stale, not the latest cause.
    expect(firstSince).toBeDefined();
    expect(staleness?.since).toBe(firstSince);
    expect(second.flagged[0]?.staleness.since).toBe(firstSince);
    expect(Date.parse(firstSince as string)).toBeLessThan(Date.parse(runtime.clock.now()));
  });
});

describe('propagate — structural change', () => {
  it('escalates every dependent to needsReview and suppresses auto-recompute', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 're-segmented', 'user');

    const report = propagate(graph, structureChange('script', next), runtime, {
      recompute: alwaysRecompute(),
    });

    expect(report.recomputed).toEqual([]);
    for (const { staleness } of report.flagged) expect(staleness.kind).toBe('needsReview');
    expect(graph.require(id('plan')).versionCount).toBe(1);
    expect(graph.require(id('plan')).needsAttention).toBe(true);
  });
});

describe('acknowledge — approve as-is', () => {
  it('clears the flag in one action without spending compute', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime);

    const video = graph.require(id('video'));
    expect(acknowledge(graph, id('video'))).toBe(true);

    expect(video.isStale).toBe(false);
    expect(video.needsAttention).toBe(false);
    expect(video.versionCount).toBe(1);
  });

  it('does not re-flag for the same change it already accepted', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime);
    acknowledge(graph, id('video'));

    const report = propagate(graph, contentChange('script', next), runtime);

    expect(graph.require(id('video')).isStale).toBe(false);
    expect(report.skipped).toContainEqual({ nodeId: id('video'), reason: 'acknowledged' });
  });

  /** Acceptance is scoped to one version, not a standing exemption from the asset. */
  it('flags again when the same upstream changes a second time', () => {
    const { graph, runtime } = pipeline();
    const v2 = seed(graph, runtime, 'script', 'rewrite one', 'user');
    propagate(graph, contentChange('script', v2), runtime);
    acknowledge(graph, id('video'));

    const v3 = seed(graph, runtime, 'script', 'rewrite two', 'user');
    propagate(graph, contentChange('script', v3), runtime);

    expect(graph.require(id('video')).staleness?.kind).toBe('outOfDate');
    expect(graph.require(id('video')).staleness?.causes).toEqual([
      { nodeId: id('script'), versionId: v3.id },
    ]);
  });

  it('returns false when there was nothing to acknowledge', () => {
    const { graph } = pipeline();
    expect(acknowledge(graph, id('video'))).toBe(false);
  });

  it('bulk-acknowledges and reports only the nodes that actually cleared', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime);

    const cleared = acknowledgeAll(graph, [id('plan'), id('image'), id('video'), id('script')]);

    expect(names(cleared)).toEqual(['plan', 'image', 'video']);
    expect(needsAttention(graph).map((n) => String(n.id))).toEqual(['timeline']);
  });
});

describe('propagate — lifecycle scoping', () => {
  it.each(['published', 'archived'] as const)('stays silent on a %s project', (lifecycle) => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');

    const report = propagate(graph, contentChange('script', next), runtime, { lifecycle });

    expect(report.suppressedByLifecycle).toBe(true);
    expect(report.flagged).toEqual([]);
    // Still reports what *would* be affected, so a UI can offer "12 archived projects use this".
    expect(names(report.affected)).toEqual(['plan', 'image', 'video', 'timeline']);
    expect(graph.require(id('video')).isStale).toBe(false);
  });

  it.each(['draft', 'active'] as const)('flags normally on a %s project', (lifecycle) => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');

    const report = propagate(graph, contentChange('script', next), runtime, { lifecycle });

    expect(report.suppressedByLifecycle).toBe(false);
    expect(report.flagged.length).toBe(4);
  });
});

describe('currentUpstreamOf', () => {
  it('pins every dependency at its current version', () => {
    const { graph } = pipeline();

    expect(currentUpstreamOf(graph, id('image'))).toEqual([
      { nodeId: id('plan'), versionId: graph.require(id('plan')).requireCurrent().id },
    ]);
  });

  it('omits dependencies that have not generated anything yet', () => {
    const graph = graphWith([
      ['plan', 'scenePlan'],
      ['image', 'sceneImage', { dependsOn: ['plan'] }],
    ]);

    expect(currentUpstreamOf(graph, id('image'))).toEqual([]);
  });
});

describe('needsAttention rollup', () => {
  it('lists failures, reviews and out-of-date media but not resolved updates', () => {
    const { graph, runtime } = pipeline();
    const next = seed(graph, runtime, 'script', 'rewritten', 'user');
    propagate(graph, contentChange('script', next), runtime, { recompute: alwaysRecompute() });

    graph.require(id('image')).fail({ code: 'OOM', message: 'no vram', retryable: true }, runtime);

    const attention = needsAttention(graph).map((n) => String(n.id));

    expect(attention).toContain('image');
    expect(attention).toContain('video');
    // plan and timeline auto-updated, so they are informational only.
    expect(attention).not.toContain('plan');
    expect(attention).not.toContain('timeline');
  });
});
