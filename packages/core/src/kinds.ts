/**
 * The fixed node-kind set (PRD §5.4: the v1 graph is not user-extensible).
 *
 * `materiality` is the single most consequential classification in the package —
 * it decides what happens to a node when something it depends on changes:
 *
 *   'derived'  Pure function of its upstream, cheap to recompute, holds no user
 *              intent. Safe to recompute automatically (PRD §5.3 step 1).
 *   'media'    Generated media. Regenerating costs real GPU time on the user's own
 *              hardware, so it is never regenerated automatically — only flagged.
 *   'authored' Carries human or model intent that a recompute would destroy. Never
 *              recomputed automatically, regardless of cost.
 *
 * The 'derived' case is further gated at runtime by version authorship: the moment a
 * user hand-edits a derived node, auto-recompute would clobber their work, so it
 * degrades to the same treatment as 'media'. See `isAutoRecomputable`.
 */
export type Materiality = 'derived' | 'media' | 'authored';

export interface NodeKindSpec {
  readonly label: string;
  readonly materiality: Materiality;
  /**
   * True for kinds that are sources by definition and may never be given
   * dependencies. Imported user media is the pure case: it came from outside the
   * pipeline, so nothing upstream can ever invalidate it (Journey C, F17).
   */
  readonly isRoot: boolean;
  /** Belongs to a single scene, so staleness can roll up to a scene card. */
  readonly sceneScoped: boolean;
}

export const NODE_KINDS = {
  // --- Pre-production sources -------------------------------------------------
  research: { label: 'Research', materiality: 'authored', isRoot: true, sceneScoped: false },
  script: { label: 'Script', materiality: 'authored', isRoot: false, sceneScoped: false },
  character: { label: 'Character', materiality: 'authored', isRoot: true, sceneScoped: false },
  location: { label: 'Location', materiality: 'authored', isRoot: true, sceneScoped: false },
  prop: { label: 'Prop', materiality: 'authored', isRoot: true, sceneScoped: false },
  voice: { label: 'Voice', materiality: 'authored', isRoot: true, sceneScoped: false },
  style: { label: 'Style', materiality: 'authored', isRoot: true, sceneScoped: false },
  userMedia: { label: 'Imported media', materiality: 'authored', isRoot: true, sceneScoped: false },

  // --- Per-scene --------------------------------------------------------------
  // One scene's slice of the script. Every script edit re-derives all of these, but
  // only the slices whose text actually moved go on to invalidate anything — which is
  // what keeps "Maya edits scene 9" from flagging all nineteen scenes.
  sceneScript: { label: 'Scene script', materiality: 'derived', isRoot: false, sceneScoped: true },
  // A real cinematography decision (shot type/framing/camera move) — costs a real
  // LLM call once the Cinematographer runs, so it's flagged on an upstream change,
  // never silently overwritten, exactly like sceneImage/sceneVideo. The cheap system
  // seed at scene creation is still just an echo of the scene text (see
  // Project.planFor), but that's a one-time bootstrap value, not an ongoing recompute.
  scenePlan: { label: 'Scene plan', materiality: 'media', isRoot: false, sceneScoped: true },
  storyboardFrame: {
    label: 'Storyboard frame',
    materiality: 'media',
    isRoot: false,
    sceneScoped: true,
  },
  sceneImage: { label: 'Scene image', materiality: 'media', isRoot: false, sceneScoped: true },
  sceneVideo: { label: 'Scene video', materiality: 'media', isRoot: false, sceneScoped: true },
  narration: { label: 'Narration', materiality: 'media', isRoot: false, sceneScoped: true },

  // --- Post -------------------------------------------------------------------
  music: { label: 'Music', materiality: 'media', isRoot: false, sceneScoped: false },
  sfx: { label: 'SFX', materiality: 'media', isRoot: false, sceneScoped: true },
  // Derived from approved script text, timed to audio — not re-transcribed (Journey A, F6).
  subtitles: { label: 'Subtitles', materiality: 'derived', isRoot: false, sceneScoped: false },
  colorGrade: { label: 'Color', materiality: 'derived', isRoot: false, sceneScoped: false },
  // Auto-assembles freely until the user trims it; authorship gating then protects
  // those trims from being clobbered by an upstream change (Journey A, step 7).
  timeline: { label: 'Timeline', materiality: 'derived', isRoot: false, sceneScoped: false },
  export: { label: 'Export', materiality: 'media', isRoot: false, sceneScoped: false },
} as const satisfies Record<string, NodeKindSpec>;

export type NodeKind = keyof typeof NODE_KINDS;

export const ALL_NODE_KINDS = Object.keys(NODE_KINDS) as readonly NodeKind[];

export const specOf = (kind: NodeKind): NodeKindSpec => NODE_KINDS[kind];

export const materialityOf = (kind: NodeKind): Materiality => NODE_KINDS[kind].materiality;

export const isRootKind = (kind: NodeKind): boolean => NODE_KINDS[kind].isRoot;

export const isSceneScoped = (kind: NodeKind): boolean => NODE_KINDS[kind].sceneScoped;

/** True when regenerating this kind consumes real inference compute. */
export const costsCompute = (kind: NodeKind): boolean => NODE_KINDS[kind].materiality === 'media';
