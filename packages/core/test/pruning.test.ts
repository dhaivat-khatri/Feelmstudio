import { describe, expect, it } from 'vitest';

import { deepEqual } from '../src/equality.js';
import type { ProjectGraph } from '../src/graph.js';
import { needsAttention, propagate, type Recomputer } from '../src/staleness.js';
import { contentChange, graphWith, id, names, rt, scene, seed, seedAll } from './helpers.js';

interface ScriptPayload {
  readonly segments: readonly string[];
}

const SEGMENTS = [
  'Compound interest is the most powerful force in personal finance.',
  'Imagine you invest one thousand dollars at seven percent.',
  'The lesson is simple: start early and let time do the work.',
];

/**
 * The real pipeline shape: one script, a per-scene slice of it, and generated media
 * hanging off each slice.
 */
function threeSceneProject() {
  const graph = graphWith([
    ['script', 'script'],
    ['s1.text', 'sceneScript', { sceneId: scene('s1'), dependsOn: ['script'] }],
    ['s2.text', 'sceneScript', { sceneId: scene('s2'), dependsOn: ['script'] }],
    ['s3.text', 'sceneScript', { sceneId: scene('s3'), dependsOn: ['script'] }],
    ['s1.img', 'sceneImage', { sceneId: scene('s1'), dependsOn: ['s1.text'] }],
    ['s2.img', 'sceneImage', { sceneId: scene('s2'), dependsOn: ['s2.text'] }],
    ['s3.img', 'sceneImage', { sceneId: scene('s3'), dependsOn: ['s3.text'] }],
    ['timeline', 'timeline', { dependsOn: ['s1.img', 's2.img', 's3.img'] }],
  ]);
  const runtime = rt();

  seed(graph, runtime, 'script', { segments: SEGMENTS } satisfies ScriptPayload);
  graph.require(id('s1.text')).addVersion({ payload: SEGMENTS[0], authorship: 'system' }, runtime);
  graph.require(id('s2.text')).addVersion({ payload: SEGMENTS[1], authorship: 'system' }, runtime);
  graph.require(id('s3.text')).addVersion({ payload: SEGMENTS[2], authorship: 'system' }, runtime);
  seedAll(graph, runtime, 's1.img', 's2.img', 's3.img', 'timeline');

  return { graph, runtime };
}

/** Re-slices the script for whichever scene it is asked about. */
const resliceScript: Recomputer = ({ node, graph }) => {
  if (node.kind !== 'sceneScript') return null;
  const index = Number(String(node.id).charAt(1)) - 1;
  const script = graph.require(id('script')).requireCurrent().payload as ScriptPayload;
  const text = script.segments[index];
  return text === undefined ? null : { payload: text };
};

const staleNames = (graph: ProjectGraph) =>
  graph.nodes.filter((n) => n.isStale).map((n) => String(n.id));

describe('propagation pruning — scoping a whole-script edit', () => {
  /**
   * Journey A, step 7. Maya rewrites two sentences in scene 2. Scenes 1 and 3 must be
   * left completely alone — a flag on all nineteen scenes is the over-flagging that
   * teaches users to ignore flags entirely.
   */
  it('flags only the scene whose text actually moved', () => {
    const { graph, runtime } = threeSceneProject();
    const edited = [SEGMENTS[0], 'Imagine you invest one thousand dollars at eight percent.', SEGMENTS[2]];

    const next = seed(graph, runtime, 'script', { segments: edited }, 'user');
    const report = propagate(graph, contentChange('script', next), runtime, {
      recompute: resliceScript,
    });

    expect(staleNames(graph)).toEqual(['s2.text', 's2.img', 'timeline']);
    expect(graph.require(id('s2.img')).staleness?.kind).toBe('outOfDate');
    expect(graph.require(id('s1.img')).isStale).toBe(false);
    expect(graph.require(id('s3.img')).isStale).toBe(false);

    // The untouched slices pruned themselves rather than propagating.
    expect(report.skipped).toContainEqual({ nodeId: id('s1.text'), reason: 'unchanged' });
    expect(report.skipped).toContainEqual({ nodeId: id('s3.text'), reason: 'unchanged' });
  });

  it('leaves untouched scenes’ media byte-for-byte intact', () => {
    const { graph, runtime } = threeSceneProject();
    const before = graph.require(id('s1.img')).requireCurrent();
    const edited = [SEGMENTS[0], 'rewritten scene two entirely', SEGMENTS[2]];

    const next = seed(graph, runtime, 'script', { segments: edited }, 'user');
    propagate(graph, contentChange('script', next), runtime, { recompute: resliceScript });

    expect(graph.require(id('s1.img')).requireCurrent()).toBe(before);
    expect(graph.require(id('s1.img')).versionCount).toBe(1);
    expect(graph.require(id('s1.text')).versionCount).toBe(1);
  });

  it('surfaces the changed scene and the assembled timeline, and nothing else', () => {
    const { graph, runtime } = threeSceneProject();
    const edited = [SEGMENTS[0], SEGMENTS[1], 'a completely different closing line'];

    const next = seed(graph, runtime, 'script', { segments: edited }, 'user');
    propagate(graph, contentChange('script', next), runtime, { recompute: resliceScript });

    // The timeline is legitimately out of date — it still contains scene 3's old
    // video — and PRD §6.2 asks for exactly that on the Overview tab. Scenes 1 and 2
    // are what must stay quiet.
    expect(needsAttention(graph).map((n) => String(n.id))).toEqual(['s3.img', 'timeline']);
  });

  it('flags every scene when every scene really did change', () => {
    const { graph, runtime } = threeSceneProject();
    const edited = ['all new one', 'all new two', 'all new three'];

    const next = seed(graph, runtime, 'script', { segments: edited }, 'user');
    const report = propagate(graph, contentChange('script', next), runtime, {
      recompute: resliceScript,
    });

    expect(names(report.recomputed)).toEqual(['s1.text', 's2.text', 's3.text']);
    expect(staleNames(graph)).toContain('s1.img');
    expect(staleNames(graph)).toContain('s2.img');
    expect(staleNames(graph)).toContain('s3.img');
  });

  it('reformatting the script without changing any scene flags nothing at all', () => {
    const { graph, runtime } = threeSceneProject();

    // A new script version whose slices are identical — e.g. the user edited a
    // heading, or re-saved without changing prose.
    const next = seed(graph, runtime, 'script', { segments: [...SEGMENTS] }, 'user');
    const report = propagate(graph, contentChange('script', next), runtime, {
      recompute: resliceScript,
    });

    expect(staleNames(graph)).toEqual([]);
    expect(report.flagged).toEqual([]);
    expect(report.recomputed).toEqual([]);
    expect(needsAttention(graph)).toEqual([]);
  });

  it('does not prune when no recomputer is supplied', () => {
    const { graph, runtime } = threeSceneProject();
    const edited = [SEGMENTS[0], 'changed', SEGMENTS[2]];

    const next = seed(graph, runtime, 'script', { segments: edited }, 'user');
    propagate(graph, contentChange('script', next), runtime);

    // Without the ability to re-derive slices, the engine cannot know which scenes
    // moved, so it conservatively flags all of them rather than guessing.
    expect(staleNames(graph)).toContain('s1.img');
    expect(staleNames(graph)).toContain('s3.img');
  });
});

describe('deepEqual', () => {
  it('compares primitives and identity', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });

  it('compares objects irrespective of key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } })).toBe(false);
  });
});
