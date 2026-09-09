import type { PersonaRole } from './agents.js';
import type { SceneId } from './ids.js';
import type { Runtime } from './runtime.js';

/**
 * A room entry is one turn in a scene deliberation: an agent thinking a scene
 * through (`think`), asking another agent for their discipline's read (`ask`),
 * or answering one (`reply`). Advisory only — the twin of a `CrewNote`, but a
 * conversation rather than an instruction, and it never touches the graph.
 */
export type RoomEntryKind = 'think' | 'ask' | 'reply';

export interface RoomEntry {
  readonly id: string;
  readonly sceneId: SceneId;
  readonly author: PersonaRole;
  readonly kind: RoomEntryKind;
  /** Target of an `ask`; addressee of a `reply`. `null` for `think`. */
  readonly to: PersonaRole | null;
  /** Id of the entry a `reply` answers. `null` otherwise. */
  readonly replyTo: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface RoomEntryInput {
  readonly sceneId: SceneId;
  readonly author: PersonaRole;
  readonly kind: RoomEntryKind;
  readonly to?: PersonaRole | null;
  /** 0-based index into the same `addMany` batch that this reply answers. */
  readonly replyToIndex?: number | null;
  readonly body: string;
}

/** A craft lesson an agent keeps — persisted cross-project by CraftMemoryStore (apps/server). */
export interface Learning {
  readonly id: string;
  readonly role: PersonaRole;
  readonly body: string;
  readonly sourceProjectId: string;
  readonly sourceSceneId: string;
  readonly createdAt: string;
}

export interface LearningDraft {
  readonly role: PersonaRole;
  readonly body: string;
}

/**
 * The project's deliberation log — every room entry from every scene huddle.
 * Deliberately plain, exactly like `NoteBoard`: advisory, never touches the
 * graph, snapshot-in / snapshot-out.
 */
export class DeliberationLog {
  private _entries: RoomEntry[] = [];

  get all(): readonly RoomEntry[] {
    return this._entries;
  }

  addMany(inputs: readonly RoomEntryInput[], rt: Runtime): RoomEntry[] {
    // One huddle is one moment — the whole batch shares a timestamp, so entry
    // order is stable and a reply never predates the ask it answers.
    const createdAt = rt.clock.now();
    const created: RoomEntry[] = inputs.map((input) => ({
      id: rt.ids.next('room'),
      sceneId: input.sceneId,
      author: input.author,
      kind: input.kind,
      to: input.to ?? null,
      replyTo: null,
      body: input.body.trim(),
      createdAt,
    }));
    // Second pass: resolve each reply's batch index to the freshly-minted id.
    inputs.forEach((input, i) => {
      const idx = input.replyToIndex;
      if (typeof idx === 'number' && idx >= 0 && idx < created.length && idx !== i) {
        created[i] = { ...created[i]!, replyTo: created[idx]!.id };
      }
    });
    this._entries.push(...created);
    return created;
  }

  /** Entries authored by, or addressed to, one role. */
  forRole(role: PersonaRole): RoomEntry[] {
    return this._entries.filter((e) => e.author === role || e.to === role);
  }

  forScene(sceneId: SceneId): RoomEntry[] {
    return this._entries.filter((e) => e.sceneId === sceneId);
  }

  toSnapshot(): readonly RoomEntry[] {
    return this._entries;
  }

  static fromSnapshot(entries: readonly RoomEntry[] | undefined): DeliberationLog {
    const log = new DeliberationLog();
    log._entries = entries ? entries.map((e) => ({ ...e })) : [];
    return log;
  }
}
