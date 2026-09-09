import { describe, expect, it } from 'vitest';

import { Project, projectId, testRuntime } from '../src/index.js';

const propose = (...texts: string[]) => texts.map((text) => ({ text }));

function project() {
  const rt = testRuntime();
  const p = new Project({ id: projectId(rt.ids.next('proj')), title: 'T' }, rt);
  p.initializeFromScript(propose('Scene one.', 'Scene two.'));
  return { p, rt };
}

describe('crew notes', () => {
  it('records a note and surfaces it in the overview, newest first', () => {
    const { p } = project();
    p.addNote({
      from: 'Director',
      to: 'Cinematographer',
      sceneId: p.sceneIds[0]!,
      body: 'Too static — add an insert of his hands.',
    });
    p.addNote({ from: 'Editor', to: 'Composer', body: 'The score fights the pacing in the middle.' });

    const ov = p.overview();
    expect(ov.notes).toHaveLength(2);
    expect(ov.openNoteCount).toBe(2);
    expect(ov.notes[0]!.body).toContain('score fights'); // newest first
    expect(ov.notes[0]!.sceneId).toBeNull();
  });

  it('openNotesFor returns a role its scene-scoped and whole-project notes only', () => {
    const { p } = project();
    const s1 = p.sceneIds[0]!;
    const s2 = p.sceneIds[1]!;
    p.addNote({ from: 'Director', to: 'Cinematographer', sceneId: s1, body: 'scene 1 note' });
    p.addNote({ from: 'Director', to: 'Cinematographer', sceneId: s2, body: 'scene 2 note' });
    p.addNote({ from: 'Director', to: 'Cinematographer', body: 'whole-project note' });
    p.addNote({ from: 'Director', to: 'Writer', sceneId: s1, body: 'not for the DP' });

    const forDp = p.openNotesFor('Cinematographer', s1).map((n) => n.body);
    expect(forDp).toEqual(['scene 1 note', 'whole-project note']);
  });

  it('marks notes addressed and drops them from openNotesFor / openNoteCount', () => {
    const { p } = project();
    const a = p.addNote({ from: 'Director', to: 'Writer', body: 'tighten the ending' });
    p.addNote({ from: 'Director', to: 'Writer', body: 'still open' });

    p.addressNotes([a.id], 'v_42');

    expect(p.openNotesFor('Writer')).toHaveLength(1);
    expect(p.overview().openNoteCount).toBe(1);
    const addressed = p.notes.find((n) => n.id === a.id)!;
    expect(addressed.status).toBe('addressed');
    expect(addressed.addressedByVersion).toBe('v_42');
  });

  it('round-trips through a snapshot', () => {
    const { p, rt } = project();
    p.addNote({ from: 'Composer', to: 'Editor', sceneId: p.sceneIds[0]!, body: 'hold the last beat longer' });
    const restored = Project.fromSnapshot(p.toSnapshot(), rt);
    expect(restored.notes).toHaveLength(1);
    expect(restored.notes[0]!.body).toBe('hold the last beat longer');
    expect(restored.notes[0]!.sceneId).toBe(p.sceneIds[0]);
  });

  it('a pre-notes snapshot (no notes field) loads clean', () => {
    const { p, rt } = project();
    const snap = { ...p.toSnapshot() } as Record<string, unknown>;
    delete snap.notes;
    const restored = Project.fromSnapshot(snap as never, rt);
    expect(restored.notes).toEqual([]);
  });
});
