import { describe, expect, it } from 'vitest';

import { CycleError, DuplicateNodeError, IllegalDependencyError, NodeNotFoundError } from '../src/errors.js';
import { ProjectGraph } from '../src/graph.js';
import { graphWith, id, names, scene } from './helpers.js';

describe('ProjectGraph — nodes', () => {
  it('adds and retrieves nodes, defaulting the label from the kind', () => {
    const graph = new ProjectGraph();
    const node = graph.addNode({ id: id('script'), kind: 'script' });

    expect(node.label).toBe('Script');
    expect(graph.size).toBe(1);
    expect(graph.get(id('script'))).toBe(node);
    expect(graph.has(id('script'))).toBe(true);
  });

  it('rejects duplicate ids rather than silently replacing a node and its history', () => {
    const graph = new ProjectGraph();
    graph.addNode({ id: id('script'), kind: 'script' });

    expect(() => graph.addNode({ id: id('script'), kind: 'script' })).toThrow(DuplicateNodeError);
  });

  it('throws a typed error for unknown ids', () => {
    const graph = new ProjectGraph();
    expect(() => graph.require(id('nope'))).toThrow(NodeNotFoundError);
    expect(graph.get(id('nope'))).toBeUndefined();
  });

  it('detaches all edges when a node is removed', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['plan', 'scenePlan', { dependsOn: ['script'] }],
      ['video', 'sceneVideo', { dependsOn: ['plan'] }],
    ]);

    graph.removeNode(id('plan'));

    expect(graph.size).toBe(2);
    expect(graph.dependentsOf(id('script'))).toEqual([]);
    expect(graph.dependenciesOf(id('video'))).toEqual([]);
  });

  it('indexes nodes by kind and by scene', () => {
    const s1 = scene('s1');
    const graph = graphWith([
      ['script', 'script'],
      ['img1', 'sceneImage', { sceneId: s1 }],
      ['vid1', 'sceneVideo', { sceneId: s1 }],
      ['img2', 'sceneImage', { sceneId: scene('s2') }],
    ]);

    expect(graph.nodesOfKind('sceneImage').map((n) => n.id)).toEqual([id('img1'), id('img2')]);
    expect(graph.nodesOfScene(s1).map((n) => n.id)).toEqual([id('img1'), id('vid1')]);
  });
});

describe('ProjectGraph — edges', () => {
  it('records dependencies in both directions', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['plan', 'scenePlan', { dependsOn: ['script'] }],
    ]);

    expect(graph.dependenciesOf(id('plan'))).toEqual([id('script')]);
    expect(graph.dependentsOf(id('script'))).toEqual([id('plan')]);
  });

  it('is idempotent — adding the same dependency twice does not duplicate it', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['plan', 'scenePlan'],
    ]);

    graph.addDependency(id('plan'), id('script'));
    graph.addDependency(id('plan'), id('script'));

    expect(graph.dependenciesOf(id('plan'))).toEqual([id('script')]);
  });

  it('rejects self-dependency', () => {
    const graph = graphWith([['plan', 'scenePlan']]);
    expect(() => graph.addDependency(id('plan'), id('plan'))).toThrow(IllegalDependencyError);
  });

  it('rejects dependencies on root kinds so imported media can never go stale', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['clip', 'userMedia'],
    ]);

    expect(() => graph.addDependency(id('clip'), id('script'))).toThrow(IllegalDependencyError);
    // The reverse is fine: generated work may depend on imported footage.
    expect(() => graph.addDependency(id('script'), id('clip'))).not.toThrow();
  });

  it('rejects a cycle and names the offending path', () => {
    const graph = graphWith([
      ['a', 'scenePlan'],
      ['b', 'sceneImage', { dependsOn: ['a'] }],
      ['c', 'sceneVideo', { dependsOn: ['b'] }],
    ]);

    try {
      graph.addDependency(id('a'), id('c'));
      expect.unreachable('expected a CycleError');
    } catch (error) {
      expect(error).toBeInstanceOf(CycleError);
      expect((error as CycleError).path.map(String)).toEqual(['a', 'b', 'c', 'a']);
    }
  });

  it('removeDependency detaches only that edge', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['style', 'style'],
      ['img', 'sceneImage', { dependsOn: ['script', 'style'] }],
    ]);

    graph.removeDependency(id('img'), id('script'));

    expect(graph.dependenciesOf(id('img'))).toEqual([id('style')]);
    expect(graph.dependentsOf(id('script'))).toEqual([]);
  });
});

describe('ProjectGraph — traversal', () => {
  it('orders dependencies before dependents', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['plan', 'scenePlan', { dependsOn: ['script'] }],
      ['img', 'sceneImage', { dependsOn: ['plan'] }],
      ['vid', 'sceneVideo', { dependsOn: ['img', 'plan'] }],
    ]);

    expect(names(graph.topoOrder())).toEqual(['script', 'plan', 'img', 'vid']);
  });

  it('returns transitive dependents in dependency-safe order', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['plan', 'scenePlan', { dependsOn: ['script'] }],
      ['img', 'sceneImage', { dependsOn: ['plan'] }],
      ['vid', 'sceneVideo', { dependsOn: ['img'] }],
      ['timeline', 'timeline', { dependsOn: ['vid'] }],
    ]);

    // Excludes the origin, includes everything downstream, plan before img before vid.
    expect(names(graph.transitiveDependents(id('script')))).toEqual([
      'plan',
      'img',
      'vid',
      'timeline',
    ]);
    expect(names(graph.transitiveDependents(id('timeline')))).toEqual([]);
  });

  it('returns transitive dependencies for provenance walks', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['plan', 'scenePlan', { dependsOn: ['script'] }],
      ['img', 'sceneImage', { dependsOn: ['plan'] }],
      ['vid', 'sceneVideo', { dependsOn: ['img'] }],
    ]);

    expect(names(graph.transitiveDependencies(id('vid')))).toEqual(['script', 'plan', 'img']);
  });

  /**
   * PRD §5.1's motivating case. A naive "flag everything downstream of Characters"
   * would flag scene 2 as well, which is exactly the over-flagging that erodes trust.
   */
  it('reaches only the scenes that actually reference a changed character', () => {
    const graph = graphWith([
      ['john', 'character'],
      ['mary', 'character'],
      ['scene1.img', 'sceneImage', { sceneId: scene('s1'), dependsOn: ['john'] }],
      ['scene2.img', 'sceneImage', { sceneId: scene('s2'), dependsOn: ['mary'] }],
      ['scene3.img', 'sceneImage', { sceneId: scene('s3'), dependsOn: ['john', 'mary'] }],
    ]);

    expect(names(graph.transitiveDependents(id('john')))).toEqual(['scene1.img', 'scene3.img']);
    expect(names(graph.transitiveDependents(id('mary')))).toEqual(['scene2.img', 'scene3.img']);
  });

  it('handles diamond dependencies without visiting a node twice', () => {
    const graph = graphWith([
      ['script', 'script'],
      ['left', 'scenePlan', { dependsOn: ['script'] }],
      ['right', 'scenePlan', { dependsOn: ['script'] }],
      ['merge', 'sceneVideo', { dependsOn: ['left', 'right'] }],
    ]);

    const affected = names(graph.transitiveDependents(id('script')));
    expect(affected).toEqual(['left', 'right', 'merge']);
    expect(new Set(affected).size).toBe(affected.length);
  });
});
