import { describe, expect, it } from 'vitest';

import { DeliberationLog, testRuntime, sceneId as toSceneId } from '../src/index.js';

const rt = () => testRuntime();
const S1 = toSceneId('scene_a');
const S2 = toSceneId('scene_b');

describe('DeliberationLog', () => {
  it('mints ids + timestamps and resolves replyToIndex to the answered entry id', () => {
    const log = new DeliberationLog();
    const [ask, reply] = log.addMany(
      [
        { sceneId: S1, author: 'Cinematographer', kind: 'ask', to: 'Writer', body: 'Is the window open or shut here?' },
        { sceneId: S1, author: 'Writer', kind: 'reply', to: 'Cinematographer', replyToIndex: 0, body: 'Shut — she is trapped.' },
      ],
      rt(),
    );
    expect(ask!.id).toMatch(/^room_/);
    expect(ask!.replyTo).toBeNull();
    expect(reply!.replyTo).toBe(ask!.id);
    expect(reply!.createdAt).toBe(ask!.createdAt); // testRuntime clock is fixed
    expect(log.all).toHaveLength(2);
  });

  it('drops a replyToIndex that is out of range to null', () => {
    const log = new DeliberationLog();
    const [only] = log.addMany([{ sceneId: S1, author: 'Editor', kind: 'reply', to: 'Director', replyToIndex: 9, body: 'x' }], rt());
    expect(only!.replyTo).toBeNull();
  });

  it('forRole returns entries authored by OR addressed to the role', () => {
    const log = new DeliberationLog();
    log.addMany(
      [
        { sceneId: S1, author: 'Director', kind: 'think', body: 'The blocking is flat.' },
        { sceneId: S1, author: 'Director', kind: 'ask', to: 'Composer', body: 'Can the score lift here?' },
        { sceneId: S1, author: 'Writer', kind: 'think', body: 'The dialogue is on the nose.' },
      ],
      rt(),
    );
    expect(log.forRole('Composer').map((e) => e.body)).toEqual(['Can the score lift here?']);
    expect(log.forRole('Director')).toHaveLength(2);
    expect(log.forRole('Editor')).toHaveLength(0);
  });

  it('forScene filters by scene', () => {
    const log = new DeliberationLog();
    log.addMany(
      [
        { sceneId: S1, author: 'Director', kind: 'think', body: 'a' },
        { sceneId: S2, author: 'Director', kind: 'think', body: 'b' },
      ],
      rt(),
    );
    expect(log.forScene(S2).map((e) => e.body)).toEqual(['b']);
  });

  it('round-trips through a snapshot', () => {
    const log = new DeliberationLog();
    log.addMany([{ sceneId: S1, author: 'Composer', kind: 'think', body: 'hold the last chord' }], rt());
    const restored = DeliberationLog.fromSnapshot(log.toSnapshot());
    expect(restored.all).toEqual(log.all);
  });

  it('fromSnapshot(undefined) is an empty log', () => {
    expect(DeliberationLog.fromSnapshot(undefined).all).toEqual([]);
  });
});
