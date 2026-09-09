import {
  Project,
  projectId,
  scenePartNode,
  testRuntime,
  type ProposedSegment,
  type Runtime,
} from '@osai/core';

const SCENES = [
  'Compound interest is the single most powerful force in personal finance.',
  'Imagine you invest one thousand dollars at seven percent annual return.',
  'After ten years that thousand becomes nearly two thousand dollars.',
  'The lesson is simple: start early and let time do the work for you.',
];

const propose = (...texts: string[]): ProposedSegment[] => texts.map((text) => ({ text }));

/** A small, real project — same fixture shape as @osai/core's own tests. */
export function buildProject(rt: Runtime = testRuntime()): Project {
  const project = new Project(
    { id: projectId('p1'), title: 'Compound interest, explained', lifecycle: 'active' },
    rt,
  );
  project.initializeFromScript(propose(...SCENES));
  return project;
}

export function generateAllMedia(project: Project): void {
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
