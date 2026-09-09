import { describe, expect, it } from 'vitest';

import { projectId, type SceneId } from '../src/ids.js';
import {
  Project,
  SCRIPT_NODE,
  TIMELINE_NODE,
  scenePartNode,
  type TimelinePayload,
} from '../src/project.js';
import type { ProposedSegment } from '../src/segmentation.js';
import { rt } from './helpers.js';

// Maya's finance explainer, four scenes.
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

/** Stands in for the inference layer: records a result for every media node. */
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

const staleNodeNames = (project: Project) =>
  project.graph.nodes.filter((n) => n.isStale).map((n) => String(n.id));

describe('Project — initialisation from a pasted script', () => {
  it('builds a scene pipeline per segment and assembles a timeline', () => {
    const { project } = mayaProject();

    expect(project.segmentation).toHaveLength(4);
    expect(project.segmentation.map((s) => s.ordinal)).toEqual([1, 2, 3, 4]);

    const scene1 = project.sceneIds[0] as SceneId;
    for (const part of ['text', 'plan', 'image', 'video', 'narration'] as const) {
      expect(project.graph.has(scenePartNode(scene1, part))).toBe(true);
    }

    const timeline = project.graph.require(TIMELINE_NODE).requireCurrent()
      .payload as TimelinePayload;
    expect(timeline.order).toEqual(project.sceneIds);
  });

  it('leaves media not started while cheap derived text is already populated', () => {
    const { project } = mayaProject();
    const scene1 = project.sceneIds[0] as SceneId;

    expect(project.graph.require(scenePartNode(scene1, 'text')).requireCurrent().payload).toBe(
      SCENES[0],
    );
    expect(project.graph.require(scenePartNode(scene1, 'image')).status).toBe('notStarted');
    expect(project.graph.require(scenePartNode(scene1, 'image')).hasVersions).toBe(false);
  });

  it('moves a media node from notStarted to needsReview once it is generated', () => {
    const { project } = mayaProject();
    const scene1 = project.sceneIds[0] as SceneId;
    const image = scenePartNode(scene1, 'image');

    expect(project.graph.require(image).status).toBe('notStarted');
    project.recordGeneration(image, `${scene1}.png`, { prompt: 'wide shot', model: 'test' });
    expect(project.graph.require(image).status).toBe('needsReview');
    expect(project.sceneSummary(scene1)?.needsAttention).toBe(true);
  });

  it('routes scene media through the scene slice, never straight off the script', () => {
    const { project } = mayaProject();
    const scene2 = project.sceneIds[1] as SceneId;

    // If image depended on the script directly, every script edit would flag it.
    // Style influence flows through the plan (Cinematographer reads it), not a
    // second direct edge — one path in, not two.
    expect(project.graph.dependenciesOf(scenePartNode(scene2, 'image'))).toEqual([
      scenePartNode(scene2, 'plan'),
    ]);
    expect(project.graph.dependenciesOf(scenePartNode(scene2, 'text'))).toEqual([SCRIPT_NODE]);
  });

  it('refuses a second initialisation', () => {
    const { project } = mayaProject();
    expect(() => project.initializeFromScript(propose('anything'))).toThrow(/already has/);
  });
});

describe('Project — generation and approval', () => {
  it('records generated media with reproducible provenance', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const scene1 = project.sceneIds[0] as SceneId;
    const image = project.graph.require(scenePartNode(scene1, 'image')).requireCurrent();

    expect(image.provenance).toMatchObject({ prompt: 'wide shot', seed: 1, model: 'sdxl' });
    expect(image.provenance.upstream.map((u) => String(u.nodeId))).toEqual([
      String(scenePartNode(scene1, 'plan')),
    ]);
  });

  it('approves everything clean and reports a settled project', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    project.approveAll();
    const overview = project.overview();

    expect(overview.needsAttention).toEqual([]);
    expect(overview.scenes).toHaveLength(4);
    expect(overview.scenes.every((s) => s.status === 'approved')).toBe(true);
    expect(overview.counts.failed).toBe(0);
  });

  it('surfaces a failed scene without disturbing its neighbours', () => {
    const { project, runtime } = mayaProject();
    generateAllMedia(project);
    project.approveAll();

    const scene3 = project.sceneIds[2] as SceneId;
    project.graph
      .require(scenePartNode(scene3, 'image'))
      .fail({ code: 'OOM', message: 'Out of VRAM', retryable: true }, runtime);

    const overview = project.overview();
    expect(overview.scenes[2]?.status).toBe('failed');
    expect(overview.scenes[2]?.needsAttention).toBe(true);
    expect(overview.scenes[0]?.status).toBe('approved');
    expect(overview.counts.failed).toBe(1);
  });
});

describe('Project — Maya edits one scene of her script', () => {
  /** Journey A, step 7 — the hardest moment in the product. */
  it('flags only the edited scene and leaves the other three completely alone', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();

    const rewritten = 'Imagine you invest one thousand dollars at eight percent annual return.';
    const { diff } = project.editScript(propose(SCENES[0] as string, rewritten, SCENES[2] as string, SCENES[3] as string));

    expect(diff.requiresReview).toBe(false);
    project.applySegmentation(diff);

    const [s1, s2, s3, s4] = project.sceneIds as [SceneId, SceneId, SceneId, SceneId];

    expect(project.graph.require(scenePartNode(s2, 'video')).staleness?.kind).toBe('outOfDate');
    expect(project.graph.require(scenePartNode(s2, 'narration')).staleness?.kind).toBe('outOfDate');

    for (const other of [s1, s3, s4]) {
      expect(project.graph.require(scenePartNode(other, 'image')).isStale).toBe(false);
      expect(project.graph.require(scenePartNode(other, 'video')).isStale).toBe(false);
      expect(project.graph.require(scenePartNode(other, 'narration')).isStale).toBe(false);
    }
  });

  it('leaves the flagged media untouched and still playable', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const s2 = project.sceneIds[1] as SceneId;
    const before = project.graph.require(scenePartNode(s2, 'video')).requireCurrent();

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'a completely rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    const video = project.graph.require(scenePartNode(s2, 'video'));
    expect(video.requireCurrent()).toBe(before);
    expect(video.versionCount).toBe(1);
  });

  it('cites the script version responsible, for a "what changed?" affordance', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const { version, diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    // plan is media now (a real Cinematographer call, not a free recompute), so it no
    // longer produces an intermediate version to blame — both it and image cite the
    // scene text directly, the thing that actually changed.
    const s2 = project.sceneIds[1] as SceneId;
    const planCauses = project.graph.require(scenePartNode(s2, 'plan')).staleness?.causes ?? [];
    expect(planCauses.map((c) => String(c.nodeId))).toContain(String(scenePartNode(s2, 'text')));

    const causes = project.graph.require(scenePartNode(s2, 'image')).staleness?.causes ?? [];
    expect(causes.map((c) => String(c.nodeId))).toContain(String(scenePartNode(s2, 'text')));
    expect(version.index).toBe(2);
  });

  it('lets Maya accept the change as-is without spending compute', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    const s2 = project.sceneIds[1] as SceneId;
    const cleared = project.acknowledgeScene(s2);

    expect(cleared).toBeGreaterThan(0);
    expect(project.sceneSummary(s2)?.staleness).toBeNull();
    expect(project.graph.require(scenePartNode(s2, 'video')).versionCount).toBe(1);
  });

  it('clears the flag once the scene is actually regenerated', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    const s2 = project.sceneIds[1] as SceneId;
    project.recordGeneration(scenePartNode(s2, 'image'), 'scene2-take2.png', { seed: 99 });
    project.recordGeneration(scenePartNode(s2, 'video'), 'scene2-take2.mp4', { seed: 99 });

    const video = project.graph.require(scenePartNode(s2, 'video'));
    expect(video.isStale).toBe(false);
    expect(video.versionCount).toBe(2);
    // The take she is replacing is still recoverable.
    expect(video.versions[0]?.payload).toBe(`${s2}.mp4`);
  });

  it('reports nothing stale when the script is re-saved unchanged', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();

    const { diff } = project.editScript(propose(...SCENES));
    project.applySegmentation(diff);

    expect(staleNodeNames(project)).toEqual([]);
    expect(project.overview().needsAttention).toEqual([]);
  });
});

describe('Project — re-segmentation', () => {
  it('splits a scene, keeps identity on one child and asks for review', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();

    const s2 = project.sceneIds[1] as SceneId;
    const { diff } = project.editScript(
      propose(
        SCENES[0] as string,
        'Imagine you invest one thousand dollars',
        'at seven percent annual return',
        SCENES[2] as string,
        SCENES[3] as string,
      ),
    );

    expect(diff.requiresReview).toBe(true);
    expect(diff.splits).toHaveLength(1);

    project.applySegmentation(diff);

    expect(project.segmentation).toHaveLength(5);
    // The original scene's generated media is still attached to a real scene.
    expect(project.sceneIds).toContain(s2);
    expect(project.graph.require(scenePartNode(s2, 'video')).staleness?.kind).toBe('needsReview');

    // The new sibling exists but has generated nothing yet.
    const sibling = project.sceneIds[2] as SceneId;
    expect(project.graph.require(scenePartNode(sibling, 'image')).status).toBe('notStarted');
  });

  it('retires a deleted scene without destroying its work', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const s3 = project.sceneIds[2] as SceneId;

    const { diff } = project.editScript(
      propose(SCENES[0] as string, SCENES[1] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    expect(project.segmentation).toHaveLength(3);
    expect(project.retiredScenes).toEqual([s3]);
    // Nodes and history survive, so putting the scene back does not mean regenerating.
    expect(project.graph.require(scenePartNode(s3, 'video')).requireCurrent().payload).toBe(
      `${s3}.mp4`,
    );
    // But it is no longer part of the assembled video.
    expect(project.graph.dependenciesOf(TIMELINE_NODE)).not.toContain(
      scenePartNode(s3, 'video'),
    );
  });

  it('does not slide identity down when an earlier scene is deleted', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const [, s2, s3, s4] = project.sceneIds as [SceneId, SceneId, SceneId, SceneId];

    const { diff } = project.editScript(
      propose(SCENES[0] as string, SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    expect(project.sceneIds[1]).toBe(s3);
    expect(project.sceneIds[2]).toBe(s4);
    expect(project.sceneIds).not.toContain(s2);
    expect(project.graph.require(scenePartNode(s3, 'video')).requireCurrent().payload).toBe(
      `${s3}.mp4`,
    );
  });
});

describe('Project — protecting hand edits', () => {
  /** Maya spends fifteen minutes trimming. An upstream edit must not undo that. */
  it('keeps a hand-trimmed timeline and flags it rather than re-assembling over it', () => {
    const { project } = mayaProject();
    generateAllMedia(project);

    project.recordEdit(TIMELINE_NODE, { order: project.sceneIds, trims: { intro: 1.5 } });

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    const timeline = project.graph.require(TIMELINE_NODE);
    expect(timeline.requireCurrent().payload).toMatchObject({ trims: { intro: 1.5 } });
    expect(timeline.staleness?.kind).toBe('outOfDate');
  });
});

describe('Project — timeline trim/reset', () => {
  it('reorders/excludes scenes and flags the timeline as manually trimmed', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const [s1, , s3, s4] = project.sceneIds as [SceneId, SceneId, SceneId, SceneId];

    project.trimTimeline([s1, s3, s4]); // drop scene 2, keep the rest in order

    const overview = project.overview();
    expect(overview.timeline.order).toEqual([s1, s3, s4]);
    expect(overview.timeline.manual).toBe(true);
  });

  it('rejects an order containing an unknown or duplicate scene', () => {
    const { project } = mayaProject();
    const [s1] = project.sceneIds as [SceneId];

    expect(() => project.trimTimeline([s1, s1])).toThrow(/duplicate/i);
    expect(() => project.trimTimeline(['not-a-real-scene' as SceneId])).toThrow();
  });

  it('reset reverts to the full auto-assembled order', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const [s1, , s3] = project.sceneIds as [SceneId, SceneId, SceneId];
    project.trimTimeline([s1, s3]);

    project.resetTimeline();

    const overview = project.overview();
    expect(overview.timeline.order).toEqual(project.sceneIds);
    expect(overview.timeline.manual).toBe(false);
  });

  it('a trim survives an upstream script edit — flagged stale, not silently overwritten', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    const [s1, , s3, s4] = project.sceneIds as [SceneId, SceneId, SceneId, SceneId];

    project.trimTimeline([s1, s3, s4]);

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    project.applySegmentation(diff);

    const timeline = project.graph.require(TIMELINE_NODE);
    expect(timeline.requireCurrent().payload).toMatchObject({ order: [s1, s3, s4] });
    expect(timeline.staleness?.kind).toBe('outOfDate');
  });
});

describe('Project — lifecycle', () => {
  it('stays silent on a published project', () => {
    const { project } = mayaProject();
    generateAllMedia(project);
    project.approveAll();
    project.lifecycle = 'published';

    const { diff } = project.editScript(
      propose(SCENES[0] as string, 'rewritten second scene', SCENES[2] as string, SCENES[3] as string),
    );
    const report = project.applySegmentation(diff);

    expect(report.suppressedByLifecycle).toBe(true);
    expect(staleNodeNames(project)).toEqual([]);
  });
});

describe('Project — deliberation rooms', () => {
  it('records room entries and surfaces the count in the overview', () => {
    const runtime = rt();
    const p = new Project({ id: projectId(runtime.ids.next('proj')), title: 'T' }, runtime);
    p.initializeFromScript([{ text: 'A woman reads a letter by a window.' }]);
    const s1 = p.sceneIds[0]!;

    p.addRoomEntries([
      { sceneId: s1, author: 'Writer', kind: 'think', body: 'The letter is the whole scene.' },
      { sceneId: s1, author: 'Cinematographer', kind: 'ask', to: 'Writer', body: 'Do we see what it says?' },
    ]);

    expect(p.rooms).toHaveLength(2);
    expect(p.overview().roomEntryCount).toBe(2);
    expect(p.roomEntriesFor('Writer')).toHaveLength(2); // authored one, addressed by one
  });

  it('rooms round-trip through a snapshot; a pre-rooms snapshot loads clean', () => {
    const runtime = rt();
    const p = new Project({ id: projectId(runtime.ids.next('proj')), title: 'T' }, runtime);
    p.initializeFromScript([{ text: 'Scene one.' }]);
    p.addRoomEntries([{ sceneId: p.sceneIds[0]!, author: 'Director', kind: 'think', body: 'Open wider.' }]);

    const restored = Project.fromSnapshot(p.toSnapshot(), runtime);
    expect(restored.rooms).toHaveLength(1);
    expect(restored.rooms[0]!.body).toBe('Open wider.');

    const snap = { ...p.toSnapshot() } as Record<string, unknown>;
    delete snap.rooms;
    expect(Project.fromSnapshot(snap as never, runtime).rooms).toEqual([]);
  });
});
