import { describe, expect, it } from 'vitest';
import { sceneId as toSceneId } from '@osai/core';
import type { InferenceAdapter } from '@osai/inference';

import { generateWriterScript, runSceneDeliberation, type SceneDeliberationResult } from '../src/agents.js';

const ctx = {
  idea: 'a diver explores a sunken library',
  style: { tone: 'eerie', palette: 'green-black', pacing: 'slow', mood: 'awe', genre: 'Drama' },
  music: { genre: 'ambient', instrumentation: 'drones', tempo: 'slow', mood: 'vast' },
  scenes: [
    {
      sceneId: 'scene_1',
      ordinal: 1,
      text: 'A diver sinks past a drowned reading room.',
      plan: 'wide · slow push',
      hasImage: true,
      hasVideo: false,
    },
  ],
} as const;

const fakeAdapter = (payload: unknown): InferenceAdapter => ({
  capability: 'text',
  generate: async () => ({ payload, model: 'fake' }),
});

describe('runSceneDeliberation', () => {
  it('fills sceneId, keeps the replyTo index, and drops junk entries/learnings', async () => {
    const adapter = fakeAdapter({
      entries: [
        { author: 'Cinematographer', kind: 'think', to: null, replyTo: null, body: 'The push needs a foreground element.' },
        { author: 'Cinematographer', kind: 'ask', to: 'Writer', replyTo: null, body: 'Is anything alive down here?' },
        { author: 'Writer', kind: 'reply', to: 'Cinematographer', replyTo: 1, body: 'One eel. That is all.' },
        { author: 'Gaffer', kind: 'think', to: null, replyTo: null, body: 'not a real persona' },
        { author: 'Editor', kind: 'chatter', to: null, replyTo: null, body: 'bad kind' },
        { author: 'Editor', kind: 'think', to: null, replyTo: null, body: '   ' },
      ],
      learnings: [
        { role: 'Writer', body: 'Restraint reads as dread. One creature, not a menagerie.' },
        { role: 'Nobody', body: 'dropped' },
        { role: 'Editor', body: '' },
      ],
    });

    const result: SceneDeliberationResult = await runSceneDeliberation(adapter, ctx, toSceneId('scene_1'), {});

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((e) => e.sceneId === toSceneId('scene_1'))).toBe(true);
    expect(result.entries[2]).toMatchObject({ author: 'Writer', kind: 'reply', replyToIndex: 1 });
    expect(result.learnings).toEqual([{ role: 'Writer', body: 'Restraint reads as dread. One creature, not a menagerie.' }]);
  });

  it('passes prior learnings into the prompt', async () => {
    let seenPrompt = '';
    const adapter: InferenceAdapter = {
      capability: 'text',
      generate: async (req) => {
        seenPrompt = req.prompt;
        return { payload: { entries: [], learnings: [] }, model: 'fake' };
      },
    };
    await runSceneDeliberation(adapter, ctx, toSceneId('scene_1'), { Writer: ['Trust the visual; cut the on-the-nose line.'] });
    expect(seenPrompt).toContain('Trust the visual; cut the on-the-nose line.');
  });

  it('returns empty arrays when the model returns nothing usable', async () => {
    const result = await runSceneDeliberation(fakeAdapter({ entries: 'nope', learnings: null }), ctx, toSceneId('scene_1'), {});
    expect(result).toEqual({ entries: [], learnings: [] });
  });
});

describe('agents fold in carried learnings', () => {
  it('generateWriterScript puts learnings in the prompt', async () => {
    let seen = '';
    const adapter: InferenceAdapter = {
      capability: 'text',
      generate: async (req) => {
        seen = req.prompt;
        return { payload: { scenes: ['A quiet scene.'] }, model: 'fake' };
      },
    };
    await generateWriterScript(adapter, 'an idea', undefined, undefined, [], ['End on an image, never a line of dialogue.']);
    expect(seen).toContain('End on an image, never a line of dialogue.');
  });
});
