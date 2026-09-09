import { describe, expect, it } from 'vitest';

import { projectId, type SceneId } from '../src/ids.js';
import {
  Project,
  SCRIPT_NODE,
  TIMELINE_NODE,
  scenePartNode,
} from '../src/project.js';
import type { ProposedSegment } from '../src/segmentation.js';
import { rt } from './helpers.js';

// Same fixture as project.test.ts, kept local so this file exercises persistence
// through the public API only, the way a real store would.
const SCENES = [
  'Compound interest is the single most powerful force in personal finance.',
  'Imagine you invest one thousand dollars at seven percent annual return.',
  'After ten years that thousand becomes nearly two thousand dollars.',
  'The lesson is simple: start early and let time do the work for you.',
];

const propose = (...texts: string[]): ProposedSegment[] => texts.map((text) => ({ text }));

function mayaProject() {
  const runtime = rt();
  const project = new Project(
    { id: projectId('p1'), title: 'Compound interest, explained', lifecycle: 'active' },
    runtime,
  );
  project.initializeFromScript(propose(...SCENES));
  return { project, runtime };
}

function generateAllMedia(project: Project): void {
  for (const scene of project.sceneIds) {
    project.recordGeneration(scenePartNode(scene, 'image'), `${scene}.png`, {
      prompt: 'wide shot',
      seed: 1,
      model: 'sdxl',
    });
    project.recordGeneration(scenePartNode(scene, 'video'), `${scene}.mp4`, { seed: 1 });
    project.recordGeneration(scenePartNode(scene, 'narration'), `${scene}.wav`, { model: 'tts' });
  }
}

/** Round-trips through JSON, the way a real file or DB store would. */
const roundTripViaJson = (project: Project) =>
  JSON.parse(JSON.stringify(project.toSnapshot()));

describe('Project — snapshot round trip', () => {
  it('is JSON-safe and restores an equivalent overview', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();

    const restored = Project.fromSnapshot(roundTripViaJson(project), rt());

    expect(restored.overview()).toEqual(project.overview());
    expect(restored.segmentation).toEqual(project.segmentation);
  });

  it('preserves every version, its provenance, and which one is current', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const scene1 = project.sceneIds[0] as SceneId;
    project.recordGeneration(scenePartNode(scene1, 'image'), 'take-2.png', { seed: 2 });

    const restored = Project.fromSnapshot(project.toSnapshot(), rt());
    const originalImage = project.graph.require(scenePartNode(scene1, 'image'));
    const restoredImage = restored.graph.require(scenePartNode(scene1, 'image'));

    expect(restoredImage.versions).toEqual(originalImage.versions);
    expect(restoredImage.requireCurrent()).toEqual(originalImage.requireCurrent());
    expect(restoredImage.requireCurrent().payload).toBe('take-2.png');
  });

  it('preserves staleness kind, causes and since', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    const restored = Project.fromSnapshot(project.toSnapshot(), rt());
    const s2 = project.sceneIds[1] as SceneId;

    expect(restored.graph.require(scenePartNode(s2, 'video')).staleness).toEqual(
      project.graph.require(scenePartNode(s2, 'video')).staleness,
    );
  });

  it('preserves acknowledgement, so a restored project does not re-nag about the same change', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);
    const s2 = project.sceneIds[1] as SceneId;
    project.acknowledgeScene(s2);

    const restored = Project.fromSnapshot(project.toSnapshot(), rt());
    expect(restored.sceneSummary(s2)?.staleness).toBeNull();

    // A later, different change to the same scene must still flag on the restored copy.
    const { diff: diff2 } = restored.editScript(
      propose(SCENES[0] as string, 'a second rewrite entirely', SCENES[2] as string, SCENES[3] as string),
    );
    restored.applySegmentation(diff2);
    expect(restored.sceneSummary(s2)?.staleness).not.toBeNull();
  });

  it('preserves retired scenes and their detachment from the timeline', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const s3 = project.sceneIds[2] as SceneId;

    const { diff } = project.editScript(propose(SCENES[0] as string, SCENES[1] as string, SCENES[3] as string));
    project.applySegmentation(diff);

    const restored = Project.fromSnapshot(project.toSnapshot(), rt());

    expect(restored.retiredScenes).toEqual([s3]);
    expect(restored.graph.dependenciesOf(TIMELINE_NODE)).not.toContain(scenePartNode(s3, 'video'));
    // The retired scene's history is not lost.
    expect(restored.graph.require(scenePartNode(s3, 'video')).requireCurrent().payload).toBe(
      `${s3}.mp4`,
    );
  });

  it('preserves lifecycle, so a restored published project stays silent', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();
    project.lifecycle = 'published';

    const restored = Project.fromSnapshot(project.toSnapshot(), rt());
    const { diff } = restored.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    const report = restored.applySegmentation(diff);

    expect(report.suppressedByLifecycle).toBe(true);
    expect(restored.graph.nodes.some((n) => n.isStale)).toBe(false);
  });

  it('gives two restores of the same snapshot independent, non-aliased state', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const snapshot = project.toSnapshot();
    const a = Project.fromSnapshot(snapshot, rt());
    const b = Project.fromSnapshot(snapshot, rt());

    const s1 = a.sceneIds[0] as SceneId;
    a.recordGeneration(scenePartNode(s1, 'image'), 'a-only.png', { seed: 5 });

    expect(a.graph.require(scenePartNode(s1, 'image')).versionCount).toBe(2);
    expect(b.graph.require(scenePartNode(s1, 'image')).versionCount).toBe(1);
  });

  it('continues to propagate correctly after restore, identically to the unsaved original', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();

    const restored = Project.fromSnapshot(project.toSnapshot(), rt());

    const editBoth = (p: Project) => {
      const { diff } = p.editScript(
        propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
      );
      return p.applySegmentation(diff);
    };

    const reportOriginal = editBoth(project);
    const reportRestored = editBoth(restored);

    expect(reportRestored.flagged.map((f) => String(f.nodeId))).toEqual(
      reportOriginal.flagged.map((f) => String(f.nodeId)),
    );
    expect(reportRestored.recomputed).toEqual(reportOriginal.recomputed);
    expect(restored.overview().needsAttention).toEqual(project.overview().needsAttention);
  });

  it('round-trips an untouched script node position unchanged', () => {
    const { project } = mayaProject();
    const restored = Project.fromSnapshot(project.toSnapshot(), rt());

    expect(restored.graph.require(SCRIPT_NODE).requireCurrent().payload).toEqual(
      project.graph.require(SCRIPT_NODE).requireCurrent().payload,
    );
  });
});
