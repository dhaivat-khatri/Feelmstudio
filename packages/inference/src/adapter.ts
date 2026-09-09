/**
 * The generative capabilities the pipeline needs (PRD's media-costing node kinds:
 * storyboardFrame/sceneImage → image, sceneVideo → video, narration → speech,
 * music/sfx → music). `Job.kind` (from @osai/jobs) is expected to be one of these
 * literally — that convention is what lets `createInferenceExecutor` route a job to
 * the right adapter without a separate mapping table.
 */
export type Capability = 'text' | 'image' | 'video' | 'speech' | 'music';

export interface InferenceRequest {
  readonly prompt: string;
  readonly seed?: number;
  /** Capability-specific extras (aspect ratio, duration, reference voice, ...). */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface InferenceResult {
  /** The artifact content, or a reference to it (URI, blob id) — opaque to this package. */
  readonly payload: unknown;
  readonly model: string;
  readonly seed?: number;
}

/**
 * Thrown by an adapter's `generate` on failure. `retryable` is the adapter's own
 * judgment about whether trying again is worth it — a rate limit or timeout is, a
 * rejected prompt or invalid request is not. `createInferenceExecutor` reads this
 * field directly into the job's retry decision.
 */
export class InferenceError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: { code: string; message: string; retryable: boolean; cause?: unknown }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'InferenceError';
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/**
 * One capability's connection to a model provider. This package defines the contract
 * and a fake implementation only — real providers (image/video/speech/text APIs or
 * self-hosted models) are a separate, later decision per capability.
 */
export interface InferenceAdapter {
  readonly capability: Capability;
  generate(request: InferenceRequest): Promise<InferenceResult>;
}

export interface FakeAdapterOptions {
  readonly model?: string;
  /** Override the response, or throw an InferenceError, to script a specific test. */
  readonly respond?: (request: InferenceRequest) => InferenceResult | Promise<InferenceResult>;
}

/**
 * Deterministic, zero-cost stand-in for a real provider. Exercises the full seam —
 * job → adapter → Project.recordGeneration — without spending money or needing an API
 * key. The default response just echoes the request back as an inert payload.
 */
export function createFakeAdapter(
  capability: Capability,
  options: FakeAdapterOptions = {},
): InferenceAdapter {
  const model = options.model ?? `fake-${capability}`;
  return {
    capability,
    async generate(request) {
      if (options.respond) return options.respond(request);
      return {
        payload: { capability, prompt: request.prompt, seed: request.seed ?? null },
        model,
        ...(request.seed !== undefined && { seed: request.seed }),
      };
    },
  };
}

const ALL_CAPABILITIES: readonly Capability[] = ['text', 'image', 'video', 'speech', 'music'];

/** A registry with every capability wired to a fake adapter — a working pipeline in one call. */
export function createFakeAdapterRegistry(
  overrides: Partial<Record<Capability, FakeAdapterOptions>> = {},
): ReadonlyMap<Capability, InferenceAdapter> {
  const registry = new Map<Capability, InferenceAdapter>();
  for (const capability of ALL_CAPABILITIES) {
    registry.set(capability, createFakeAdapter(capability, overrides[capability]));
  }
  return registry;
}
