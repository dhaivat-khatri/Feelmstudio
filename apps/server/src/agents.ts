import {
  STYLE_NODE,
  scenePartNode,
  type Agent,
  type CrewNote,
  type LearningDraft,
  type MusicPayload,
  type PersonaRole,
  type RoomEntryInput,
  type SceneId,
  type ScenePlanPayload,
  type StylePayload,
} from '@osai/core';
import type { InferenceAdapter, ResearchAdapter, ResearchResult } from '@osai/inference';

/**
 * Renders open crew notes into a prompt block an agent can act on. Empty string
 * when there's nothing to address, so it drops out of the prompt cleanly.
 */
function notesBlock(notes: readonly CrewNote[]): string[] {
  if (notes.length === 0) return [];
  return [
    'The crew left notes on your last pass — address each one in this revision:',
    ...notes.map((n) => `- (${n.from}) ${n.body}`),
    '',
  ];
}

/**
 * A prompt block of an agent's carried craft lessons — the lessons it distilled
 * in past scene deliberations (see runSceneDeliberation / CraftMemoryStore).
 * Empty string list when it has none, so it drops out of the prompt cleanly.
 */
export function learningsBlock(learnings: readonly string[]): string[] {
  if (learnings.length === 0) return [];
  return ['Lessons you carry from past productions — let them shape this work:', ...learnings.map((l) => `- ${l}`), ''];
}

/** The 5 producing personas — a stable, closed cast for the dailies/meeting prompts. */
const CREW: readonly PersonaRole[] = ['Director', 'Writer', 'Cinematographer', 'Composer', 'Editor'];

export interface CrewNoteDraft {
  readonly from: PersonaRole;
  readonly to: PersonaRole;
  readonly sceneId?: string | null;
  readonly body: string;
}

/** A scene's produced state, flattened for the dailies/meeting prompts. */
export interface SceneReview {
  readonly sceneId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly plan?: string;
  readonly hasImage: boolean;
  readonly hasVideo: boolean;
}

export interface DailiesResult {
  readonly verdicts: Array<{ sceneId: string; verdict: 'works' | 'needs work'; reasoning: string }>;
  readonly notes: CrewNoteDraft[];
}

export interface ProductionMeetingResult {
  readonly transcript: Array<{ speaker: string; role: PersonaRole; line: string }>;
  readonly notes: CrewNoteDraft[];
}

/**
 * The Director: sets the creative brief from a one-line idea. Has no graph
 * dependencies (`style` is a root node), so the idea text can't arrive via
 * `AgentRequest.inputs` — it's captured in this closure instead, built fresh per
 * request by the route that has it.
 */
export function createDirectorAgent(textAdapter: InferenceAdapter, idea: string, learnings: readonly string[] = []): Agent {
  return async () => {
    const result = await textAdapter.generate({
      prompt: [
        `Idea: ${idea}`,
        '',
        ...learningsBlock(learnings),
        'Return ONLY a JSON object with these exact keys:',
        '{"tone": string, "palette": string, "pacing": string, "mood": string, "format": string, "genre": string, "runtimeMinutes": number, "characters": [string, ...], "locations": [string, ...], "visualAnchor": string}',
        '',
        '"format" is the production type (e.g. "Short Film", "Explainer", "Social Clip"). "genre" is one or two words (e.g. "Sci-Fi Thriller"). "runtimeMinutes" is your best estimate for how long this idea plays out. "characters" and "locations" are short name-only lists (1-4 entries each) implied by the idea — invent plausible ones if the idea does not name any. "visualAnchor" is 2-3 sentences of concrete visual continuity that EVERY scene must honour: the main character\'s exact age, build, face, hair and wardrobe; the single primary location\'s look; and the film stock / lighting (e.g. "warm 35mm, soft practical light"). Be specific enough that two artists drawing different scenes would draw the same person and place.',
        '',
        'Example for a different idea ("a lighthouse keeper spends one last night on duty"):',
        '{"tone": "melancholic", "palette": "cool blues and warm lamp-light", "pacing": "slow, contemplative", "mood": "wistful", "format": "Short Film", "genre": "Drama", "runtimeMinutes": 4, "characters": ["The Keeper"], "locations": ["Lighthouse Tower", "Rocky Shore"]}',
      ].join('\n'),
      params: {
        systemPrompt:
          'You are a film director setting the creative brief for a short video — the Production Bible every other department reads from. Respond with only the JSON object described — no prose, no markdown fences.',
      },
    });
    return { payload: result.payload as StylePayload, model: result.model };
  };
}

/**
 * The Researcher: fact-checks the idea before the Writer drafts, via the Parallel
 * Search API. Not a graph-node `Agent` and not persisted — the orchestrator (and
 * the wizard) holds the result for one run and passes it into script generation
 * (see routes.ts). The idea plus a genre hint becomes the search objective.
 */
export async function runResearch(
  researchAdapter: ResearchAdapter,
  idea: string,
  style: StylePayload | undefined,
): Promise<ResearchResult> {
  const objective = [
    `Real-world facts, cultural detail, and historical context a screenwriter needs to portray this short-video idea authentically: "${idea}".`,
    style?.genre ? `Genre: ${style.genre}.` : '',
    'Prioritise concrete, verifiable specifics — places, customs, everyday texture, dates — over general commentary.',
  ]
    .filter(Boolean)
    .join(' ');
  return researchAdapter.research(objective);
}

/**
 * The Writer: drafts the full script from the idea + the Director's brief, split
 * into scenes. Not a graph-node `Agent` — its output isn't committed directly, it
 * fills the same textarea a pasted script would, so "accept" is the existing
 * paste-script save path (`POST /projects/:id/script`), not a new commit route.
 *
 * When `research` is supplied (from the Researcher step), its findings are
 * dropped into the prompt so the Writer keeps factual claims consistent with
 * them and cites the sources.
 */
export async function generateWriterScript(
  textAdapter: InferenceAdapter,
  idea: string,
  style: StylePayload | undefined,
  research?: ResearchResult,
  notes: readonly CrewNote[] = [],
  learnings: readonly string[] = [],
): Promise<string> {
  const researchBlock =
    research && research.findings.length > 0
      ? [
          'Ground every factual claim in these researched findings — do not invent facts beyond them:',
          ...research.findings.map((f) => `- ${f}`),
          research.sources.length > 0 ? `Sources: ${research.sources.map((s) => s.url).join(', ')}` : '',
          '',
        ]
      : [];

  const result = await textAdapter.generate({
    prompt: [
      `Idea: ${idea}`,
      style && `Style — tone: ${style.tone}, palette: ${style.palette}, pacing: ${style.pacing}, mood: ${style.mood}`,
      '',
      ...notesBlock(notes),
      ...learningsBlock(learnings),
      ...researchBlock,
      'Write the script as a JSON object: {"scenes": [string, ...]}. 3 to 6 scenes.',
      'Each array entry is ONLY plain prose describing what happens and what it looks like — a sentence or two, nothing else. Never include camera angles, shot types, framing, or any key-value/JSON structure inside a scene\'s text — that is a separate job, done later by someone else. Just plain sentences, like a paragraph in a short story.',
      '',
      'Example of a correctly formatted reply for a different idea:',
      '{"scenes": ["A boy walks alone along a foggy beach at dawn, waves lapping at his bare feet.", "He stops, spotting a small wooden boat half-buried in the sand ahead of him."]}',
    ]
      .filter(Boolean)
      .join('\n'),
    params: {
      systemPrompt:
        'You are a screenwriter drafting a short video script, scene by scene. Each scene is plain prose only — never camera directions, shot lists, or nested JSON/key-value pairs inside the scene text. When researched findings are provided, keep every factual claim consistent with them. Respond with only the JSON object described — no prose outside it, no markdown fences.',
    },
  });

  const { scenes } = result.payload as { scenes: string[] };
  return scenes.join('\n\n');
}

/**
 * The Cinematographer: decides shot type, framing, camera move per scene. Reads the
 * scene's text and the project's style brief — both already on the graph as this
 * node's dependencies (see `Project.buildScene`), so `runNode` supplies them via
 * `inputs` with no extra wiring needed here.
 */
export function createCinematographerAgent(
  textAdapter: InferenceAdapter,
  notes: readonly CrewNote[] = [],
  learnings: readonly string[] = [],
): Agent {
  return async ({ node, inputs }) => {
    const current = node.current?.payload as ScenePlanPayload | undefined;
    const sceneId = node.sceneId;
    const text = sceneId ? (inputs.get(scenePartNode(sceneId, 'text')) as string | undefined) : undefined;
    const style = inputs.get(STYLE_NODE) as StylePayload | undefined;

    const result = await textAdapter.generate({
      prompt: [
        `Scene: ${text ?? current?.text ?? ''}`,
        style && `Style — tone: ${style.tone}, palette: ${style.palette}, pacing: ${style.pacing}, mood: ${style.mood}`,
        '',
        ...notesBlock(notes),
        ...learningsBlock(learnings),
        'Return ONLY a JSON object: {"shotType": string, "framing": string, "cameraMove": string, "durationSeconds": number}',
      ]
        .filter(Boolean)
        .join('\n'),
      params: {
        systemPrompt:
          'You are a cinematographer deciding how to shoot one scene of a short video. Respond with only a JSON object — no prose, no markdown fences.',
      },
    });

    const plan = result.payload as Omit<ScenePlanPayload, 'sceneId' | 'ordinal' | 'text'>;
    const payload: ScenePlanPayload = {
      sceneId: sceneId!,
      ordinal: current?.ordinal ?? 0,
      text: text ?? current?.text ?? '',
      ...plan,
    };
    return { payload, model: result.model };
  };
}

/**
 * The Composer: decides the score's musical direction from the project's style
 * brief — already wired as MUSIC_NODE's one graph dependency (see
 * `Project.seedMusicNode`), so `runNode` supplies it via `inputs` with no extra
 * wiring needed here, same as the Cinematographer reading style.
 */
export function createComposerAgent(
  textAdapter: InferenceAdapter,
  notes: readonly CrewNote[] = [],
  learnings: readonly string[] = [],
): Agent {
  return async ({ inputs }) => {
    const style = inputs.get(STYLE_NODE) as StylePayload | undefined;

    const result = await textAdapter.generate({
      prompt: [
        style && `Style — tone: ${style.tone}, palette: ${style.palette}, pacing: ${style.pacing}, mood: ${style.mood}`,
        style?.genre && `Genre: ${style.genre}`,
        '',
        ...notesBlock(notes),
        ...learningsBlock(learnings),
        'Return ONLY a JSON object: {"genre": string, "instrumentation": string, "tempo": string, "mood": string, "direction": string}',
        '',
        '"genre" is the musical genre (e.g. "minimal electronic", "orchestral"). "instrumentation" lists the key instruments. "tempo" is a plain description (e.g. "slow, builds midway"). "mood" is the emotional quality. "direction" is one or two sentences describing how the score should support the story.',
      ]
        .filter(Boolean)
        .join('\n'),
      params: {
        systemPrompt:
          'You are a composer deciding the musical direction for a short film score. Respond with only the JSON object described — no prose, no markdown fences.',
      },
    });

    return { payload: result.payload as MusicPayload, model: result.model };
  };
}

/**
 * The Composer, second act: turn the committed music brief into an actual
 * soundtrack clip via a music model (Lyria). Synchronous and single-shot — the
 * caller (the `/music/render` route) is timeout-bounded and never loops. Returns
 * the generated clip's file path plus the model that made it.
 */
export async function renderMusicTrack(
  musicAdapter: InferenceAdapter,
  brief: MusicPayload,
): Promise<{ filePath: string; model: string }> {
  const prompt = [
    brief.genre && `${brief.genre}`,
    brief.instrumentation && `featuring ${brief.instrumentation}`,
    brief.tempo && `tempo: ${brief.tempo}`,
    brief.mood && `mood: ${brief.mood}`,
    'instrumental, no vocals, film score',
  ]
    .filter(Boolean)
    .join(', ');

  const result = await musicAdapter.generate({ prompt });
  const { filePath } = result.payload as { filePath: string };
  return { filePath, model: result.model };
}

// --- Layer 2 & 3: crew coordination ------------------------------------------

/** Shared context both the dailies and the production meeting reason over. */
export interface CrewContext {
  readonly idea: string;
  readonly style: StylePayload;
  readonly music: MusicPayload;
  readonly runtimeMinutes?: number;
  readonly scenes: readonly SceneReview[];
}

function crewContextBlock(ctx: CrewContext): string {
  return [
    `IDEA: ${ctx.idea}`,
    `BRIEF: tone ${ctx.style.tone}; palette ${ctx.style.palette}; pacing ${ctx.style.pacing}; mood ${ctx.style.mood}; genre ${ctx.style.genre ?? '—'}${
      ctx.runtimeMinutes ? `; target runtime ${ctx.runtimeMinutes} min` : ''
    }`,
    `SCORE: ${ctx.music.genre} — ${ctx.music.instrumentation}; ${ctx.music.tempo}; ${ctx.music.mood}`,
    '',
    'SCENES:',
    ...ctx.scenes.map(
      (s) =>
        `  ${s.ordinal}. [${s.sceneId}] ${s.text}` +
        (s.plan ? `\n     shot: ${s.plan}` : '') +
        `\n     media: image=${s.hasImage ? 'yes' : 'no'}, video=${s.hasVideo ? 'yes' : 'no'}`,
    ),
  ].join('\n');
}

const NOTE_SHAPE =
  'A note is {"from": one of ' +
  JSON.stringify(CREW) +
  ', "to": one of the same, "sceneId": a scene id from above or null for a whole-project note, "body": one specific, actionable instruction}.';

/**
 * Layer 2 — Dailies. The Director reviews the actual produced cut and dictates
 * notes, exactly as they would watching the day's footage. Grounded entirely in
 * `ctx` (real brief + scripts + plans + media state); nothing invented.
 */
export async function runDailies(textAdapter: InferenceAdapter, ctx: CrewContext): Promise<DailiesResult> {
  const result = await textAdapter.generate({
    prompt: [
      crewContextBlock(ctx),
      '',
      'You are the Director at the dailies review. For each scene give a verdict ("works" or "needs work") and a one-line reason. Then dictate a short list of notes to specific crew members to fix what needs work — be concrete (what to change, where). ' +
        NOTE_SHAPE,
      '',
      'Return ONLY this JSON object:',
      '{"verdicts": [{"sceneId": string, "verdict": "works" | "needs work", "reasoning": string}], "notes": [{"from": "Director", "to": string, "sceneId": string | null, "body": string}]}',
    ].join('\n'),
    params: {
      systemPrompt:
        'You are a film director running the dailies review of a short video. You are decisive and specific — every note names a change and where it applies. Respond with only the JSON object described, no prose, no markdown fences.',
    },
  });
  const payload = result.payload as DailiesResult;
  return {
    verdicts: Array.isArray(payload.verdicts) ? payload.verdicts : [],
    notes: sanitizeNotes(payload.notes),
  };
}

/**
 * Layer 3 — Production meeting. All five personas discuss the cut and coordinate
 * laterally: the Cinematographer can note the Writer, the Composer the Editor,
 * anyone can flag the Director. Output is a transcript plus notes with from/to.
 */
export async function runProductionMeeting(
  textAdapter: InferenceAdapter,
  ctx: CrewContext,
): Promise<ProductionMeetingResult> {
  const result = await textAdapter.generate({
    prompt: [
      crewContextBlock(ctx),
      '',
      'Write the transcript of a short production meeting where the crew reviews this cut: Ezra Vantage (Director), Lyra Inkwell (Writer), Revo Luxin (Cinematographer), Sonic Vyra (Composer), Kai Cutter (Editor). Each speaks from their discipline. They flag what matches the brief and what does not, disagree where a real crew would, and agree on concrete fixes. 6–12 turns. Then list the notes they agreed on — who owes whom what. ' +
        NOTE_SHAPE,
      '',
      'Return ONLY this JSON object:',
      '{"transcript": [{"speaker": string, "role": one of ' +
        JSON.stringify(CREW) +
        ', "line": string}], "notes": [{"from": string, "to": string, "sceneId": string | null, "body": string}]}',
    ].join('\n'),
    params: {
      systemPrompt:
        'You write realistic film production-meeting dialogue. The crew is collegial but candid; they name specific scenes and specific changes. Respond with only the JSON object described, no prose, no markdown fences.',
    },
  });
  const payload = result.payload as ProductionMeetingResult;
  return {
    transcript: Array.isArray(payload.transcript) ? payload.transcript : [],
    notes: sanitizeNotes(payload.notes),
  };
}

/** Drop anything the model returned that isn't a well-formed note to a real role. */
function sanitizeNotes(notes: unknown): CrewNoteDraft[] {
  if (!Array.isArray(notes)) return [];
  return notes.flatMap((n): CrewNoteDraft[] => {
    const from = (n as CrewNoteDraft)?.from;
    const to = (n as CrewNoteDraft)?.to;
    const body = (n as CrewNoteDraft)?.body;
    if (!CREW.includes(from) || !CREW.includes(to) || typeof body !== 'string' || body.trim().length === 0) return [];
    return [{ from, to, sceneId: (n as CrewNoteDraft).sceneId ?? null, body: body.trim() }];
  });
}

export interface SceneDeliberationResult {
  readonly entries: RoomEntryInput[];
  readonly learnings: LearningDraft[];
}

/**
 * Layer 4 — a scene huddle. The five personas talk ONE scene through: each
 * thinks from their craft, asks another discipline where its eye would sharpen
 * the scene, answers what it is asked, and names one lesson to carry forward.
 * On-demand only, one LLM call, observational — it emits room entries + learning
 * drafts and touches nothing on the graph.
 */
export async function runSceneDeliberation(
  textAdapter: InferenceAdapter,
  ctx: CrewContext,
  sceneId: SceneId,
  priorLearnings: Partial<Record<PersonaRole, readonly string[]>>,
): Promise<SceneDeliberationResult> {
  const memoryBlock = CREW.flatMap((role) => {
    const lessons = priorLearnings[role] ?? [];
    return lessons.length > 0
      ? [`${role} carries these lessons from past productions:`, ...lessons.map((l) => `  - ${l}`)]
      : [];
  });

  const result = await textAdapter.generate({
    prompt: [
      crewContextBlock(ctx),
      '',
      `The crew is huddled on scene [${sceneId}] specifically. Talk it through.`,
      ...(memoryBlock.length > 0 ? ['', ...memoryBlock] : []),
      '',
      "Each of the five — Director, Writer, Cinematographer, Composer, Editor — speaks only from their discipline. Each THINKS aloud about this scene (1-2 turns), ASKS at least one other agent where another discipline's eye would sharpen it, and REPLIES to what is asked of them. 8 to 14 turns total. Then each names ONE lesson they will carry into future films — a durable professional principle, not a fix for this scene.",
      '',
      'Return ONLY this JSON object:',
      '{"entries": [{"author": one of ' +
        JSON.stringify(CREW) +
        ', "kind": "think" | "ask" | "reply", "to": one of ' +
        JSON.stringify(CREW) +
        ' or null, "replyTo": 0-based index into this entries array or null, "body": string}], "learnings": [{"role": one of ' +
        JSON.stringify(CREW) +
        ', "body": string}]}',
    ].join('\n'),
    params: {
      systemPrompt:
        'You write realistic film-crew deliberation for a scene huddle. Each agent speaks only from their discipline, names this specific scene and specific craft concerns, and asks real questions of the others. Lessons are durable professional principles, never fixes for this scene. Respond with only the JSON object described — no prose, no markdown fences.',
    },
  });

  const payload = result.payload as { entries?: unknown; learnings?: unknown };
  return {
    entries: sanitizeRoomEntries(payload.entries, sceneId),
    learnings: sanitizeLearnings(payload.learnings),
  };
}

type RawEntry = { author?: unknown; kind?: unknown; to?: unknown; replyTo?: unknown; body?: unknown };
const ENTRY_KINDS = new Set(['think', 'ask', 'reply']);

/** Drop anything that isn't a well-formed room turn from a real persona; clamp the replyTo index. */
function sanitizeRoomEntries(raw: unknown, sceneId: SceneId): RoomEntryInput[] {
  if (!Array.isArray(raw)) return [];
  const n = raw.length;
  return raw.flatMap((r: RawEntry, i): RoomEntryInput[] => {
    const author = r?.author;
    const kind = r?.kind;
    const body = r?.body;
    if (!CREW.includes(author as PersonaRole)) return [];
    if (typeof kind !== 'string' || !ENTRY_KINDS.has(kind)) return [];
    if (typeof body !== 'string' || body.trim().length === 0) return [];
    const to = CREW.includes(r?.to as PersonaRole) ? (r.to as PersonaRole) : null;
    const idx = typeof r?.replyTo === 'number' && r.replyTo >= 0 && r.replyTo < n && r.replyTo !== i ? r.replyTo : null;
    return [
      { sceneId, author: author as PersonaRole, kind: kind as RoomEntryInput['kind'], to, replyToIndex: idx, body: body.trim() },
    ];
  });
}

function sanitizeLearnings(raw: unknown): LearningDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l: { role?: unknown; body?: unknown }): LearningDraft[] => {
    const role = l?.role;
    const body = l?.body;
    if (!CREW.includes(role as PersonaRole) || typeof body !== 'string' || body.trim().length === 0) return [];
    return [{ role: role as PersonaRole, body: body.trim() }];
  });
}
