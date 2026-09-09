import type { PersonaRole } from './agents.js';
import type { SceneId } from './ids.js';
import type { Runtime } from './runtime.js';

/**
 * A note is the atomic unit of direction on a real set: one specific, actionable
 * instruction from one crew role to another, optionally scoped to a scene, with
 * an open/addressed state. The Director issues them after dailies; any agent can
 * issue one to any other in a production meeting. A downstream agent folds the
 * open notes addressed to it into its next regeneration, then marks them
 * addressed — that closed loop is how a suggestion actually gets implemented.
 */
export interface CrewNote {
  readonly id: string;
  readonly from: PersonaRole;
  readonly to: PersonaRole;
  /** `null` = a whole-project note (pacing, runtime, tone), not scene-specific. */
  readonly sceneId: SceneId | null;
  readonly body: string;
  readonly status: 'open' | 'addressed';
  readonly createdAt: string;
  readonly addressedAt: string | null;
  /** Version id of the regeneration that addressed it, when known — for the decision log. */
  readonly addressedByVersion: string | null;
}

export interface NoteInput {
  readonly from: PersonaRole;
  readonly to: PersonaRole;
  readonly sceneId?: SceneId | null;
  readonly body: string;
}

/**
 * The project's note-board. Deliberately plain: notes are advisory, never touch
 * the graph, and are snapshot-in / snapshot-out like the rest of `Project`.
 */
export class NoteBoard {
  private _notes: CrewNote[] = [];

  get all(): readonly CrewNote[] {
    return this._notes;
  }

  get openCount(): number {
    return this._notes.filter((n) => n.status === 'open').length;
  }

  add(input: NoteInput, rt: Runtime): CrewNote {
    const note: CrewNote = {
      id: rt.ids.next('note'),
      from: input.from,
      to: input.to,
      sceneId: input.sceneId ?? null,
      body: input.body.trim(),
      status: 'open',
      createdAt: rt.clock.now(),
      addressedAt: null,
      addressedByVersion: null,
    };
    this._notes.push(note);
    return note;
  }

  /** Open notes for one role, optionally narrowed to a scene (scene-scoped + whole-project). */
  openFor(role: PersonaRole, sceneId?: SceneId): CrewNote[] {
    return this._notes.filter(
      (n) =>
        n.status === 'open' && n.to === role && (sceneId === undefined || n.sceneId === null || n.sceneId === sceneId),
    );
  }

  address(ids: readonly string[], rt: Runtime, byVersionId?: string): void {
    const set = new Set(ids);
    this._notes = this._notes.map((n) =>
      set.has(n.id) && n.status === 'open'
        ? { ...n, status: 'addressed', addressedAt: rt.clock.now(), addressedByVersion: byVersionId ?? null }
        : n,
    );
  }

  toSnapshot(): readonly CrewNote[] {
    return this._notes;
  }

  static fromSnapshot(notes: readonly CrewNote[] | undefined): NoteBoard {
    const board = new NoteBoard();
    board._notes = notes ? notes.map((n) => ({ ...n })) : [];
    return board;
  }
}
