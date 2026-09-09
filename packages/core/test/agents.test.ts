import { describe, expect, it } from 'vitest';

import {
  type Agent,
  type AgentRegistry,
  type AgentRequest,
  readyToRun,
  runNode,
} from '../src/agents.js';
import { projectId } from '../src/ids.js';
import { Project, SCRIPT_NODE, STYLE_NODE, scenePartNode } from '../src/project.js';
import type { ProposedSegment } from '../src/segmentation.js';
import { rt } from './helpers.js';

const propose = (...texts: string[]): ProposedSegment[] => texts.map((text) => ({ text }));

function studio() {
  const runtime = rt();
  const project = new Project(
    { id: projectId('p1'), title: 'Mythology short', lifecycle: 'active' },
    runtime,
  );
  project.initializeFromScript(propose('Scene one text.', 'Scene two text.'));
  return project;
}

/**
 * The five crew roles, each one function bound to the node kind it owns.
 *
 *   director        -> style      the creative brief everything else reads
 *   writer          -> script     storyline and dialogue
 *   cinematographer -> scenePlan  shot type, framing, camera move
 *   composer        -> music      score and stings
 *   editor          -> timeline   assembly, order, pacing
 */
const crew: AgentRegistry = {
  style: async () => ({ payload: { tone: 'ominous', palette: 'cold' }, model: 'director-v1' }),
  script: async () => ({ payload: { segments: ['A.', 'B.'] }, model: 'writer-v1' }),
  scenePlan: async ({ node }) => ({
    payload: { shot: 'low angle wide', camera: 'slow push in', for: node.id },
    model: 'dp-v1',
  }),
  music: async () => ({ payload: { cue: 'low drone, 90bpm' }, model: 'composer-v1' }),
  timeline: async ({ inputs }) => ({ payload: { clips: inputs.size }, model: 'editor-v1' }),
};

describe('agents', () => {
  it('runs an agent and records the result with reproducible provenance', async () => {
    const project = studio();

    await runNode(project, STYLE_NODE, crew);

    const version = project.graph.require(STYLE_NODE).requireCurrent();
    expect(version.payload).toEqual({ tone: 'ominous', palette: 'cold' });
    expect(version.provenance.model).toBe('director-v1');
    expect(version.provenance.authorship).toBe('system');
  });

  it('returns null for a kind with no agent instead of inventing one', async () => {
    const project = studio();
    expect(await runNode(project, scenePartNode(project.sceneIds[0]!, 'video'), crew)).toBeNull();
  });

  it('passes upstream payloads in as inputs', async () => {
    const project = studio();
    const scene = project.sceneIds[0]!;
    let captured: AgentRequest | undefined;

    const spy: Agent = async (request) => {
      captured = request;
      return { payload: { shot: 'wide' } };
    };
    await runNode(project, scenePartNode(scene, 'plan'), { scenePlan: spy });

    // A scene plan reads that scene's text and the project's style brief (see buildScene).
    expect([...(captured?.inputs.keys() ?? [])]).toEqual([scenePartNode(scene, 'text'), STYLE_NODE]);
  });

  it('marks the node failed and rethrows when an agent throws', async () => {
    const project = studio();
    const boom: AgentRegistry = {
      style: async () => {
        throw new Error('model server unreachable');
      },
    };

    await expect(runNode(project, STYLE_NODE, boom)).rejects.toThrow('model server unreachable');

    const node = project.graph.require(STYLE_NODE);
    expect(node.status).toBe('failed');
    expect(node.failure).toMatchObject({ code: 'AGENT_ERROR', retryable: true });
  });

  it('only offers work whose dependencies already have versions', () => {
    const project = studio();
    const ready = readyToRun(project, crew);

    expect(ready.every((id) => crew[project.graph.require(id).kind] !== undefined)).toBe(true);
    expect(
      ready.every((id) =>
        project.graph.dependenciesOf(id).every((dep) => project.graph.require(dep).hasVersions),
      ),
    ).toBe(true);
  });

  it('offers work in dependency-safe order', () => {
    const project = studio();
    const order = project.graph.topoOrder();

    const positions = readyToRun(project, crew).map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  /** Re-directing the film re-flags the scenes that read the brief — for free. */
  it('propagates a director change through the existing staleness engine', async () => {
    const project = studio();
    await runNode(project, scenePartNode(project.sceneIds[0]!, 'plan'), crew);
    project.recordGeneration(scenePartNode(project.sceneIds[0]!, 'image'), 's1.png');

    const report = await runNode(project, STYLE_NODE, crew);

    expect(report?.flagged.length).toBeGreaterThan(0);
    expect(project.graph.require(SCRIPT_NODE).isStale).toBe(false);
  });
});
