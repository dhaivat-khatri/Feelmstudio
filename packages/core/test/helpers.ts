import { ProjectGraph } from '../src/graph.js';
import { nodeId, type NodeId, type SceneId, type VersionId } from '../src/ids.js';
import type { NodeKind } from '../src/kinds.js';
import { testRuntime, type Runtime } from '../src/runtime.js';
import { currentUpstreamOf, type ChangeEvent, type Recomputer } from '../src/staleness.js';
import type { Authorship } from '../src/version.js';

export const id = (raw: string): NodeId => nodeId(raw);
export const scene = (raw: string): SceneId => raw as SceneId;

export const rt = () => testRuntime();

interface AddOpts {
  readonly label?: string;
  readonly sceneId?: SceneId;
  /** Ids this node depends on, added in order. */
  readonly dependsOn?: readonly string[];
}

/** Terse graph construction so tests read as structure, not setup. */
export function graphWith(
  spec: ReadonlyArray<readonly [name: string, kind: NodeKind, opts?: AddOpts]>,
): ProjectGraph {
  const graph = new ProjectGraph();
  for (const [name, kind, opts] of spec) {
    graph.addNode({
      id: id(name),
      kind,
      ...(opts?.label !== undefined && { label: opts.label }),
      ...(opts?.sceneId !== undefined && { sceneId: opts.sceneId }),
    });
  }
  for (const [name, , opts] of spec) {
    for (const dep of opts?.dependsOn ?? []) graph.addDependency(id(name), id(dep));
  }
  return graph;
}

export const names = (ids: readonly NodeId[]): string[] => ids.map(String);

/** Gives a node a starting version, as if it had already been generated once. */
export function seed(
  graph: ProjectGraph,
  runtime: Runtime,
  name: string,
  payload: unknown = `${name}-v1`,
  authorship: Authorship = 'system',
) {
  const node = graph.require(id(name));
  return node.addVersion(
    { payload, authorship, upstream: currentUpstreamOf(graph, node.id) },
    runtime,
  );
}

/** Seeds every named node in dependency order. */
export function seedAll(graph: ProjectGraph, runtime: Runtime, ...nodeNames: string[]): void {
  for (const name of nodeNames) seed(graph, runtime, name);
}

export const contentChange = (nodeIdName: string, version: { id: VersionId }): ChangeEvent => ({
  nodeId: id(nodeIdName),
  versionId: version.id,
  nature: 'content',
});

export const structureChange = (nodeIdName: string, version: { id: VersionId }): ChangeEvent => ({
  nodeId: id(nodeIdName),
  versionId: version.id,
  nature: 'structure',
});

/** A recomputer that always succeeds, stamping the node id so payloads are checkable. */
export const alwaysRecompute =
  (tag = 'recomputed'): Recomputer =>
  ({ node }) => ({ payload: `${tag}:${node.id}` });
