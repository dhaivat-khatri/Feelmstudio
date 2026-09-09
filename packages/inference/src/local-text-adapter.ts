import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { InferenceError, type InferenceAdapter, type InferenceRequest, type InferenceResult } from './adapter.js';

const run = promisify(execFile);

/** The venv this package installs mlx-lm into (see packages/inference/README.md). */
const DEFAULT_MLX_LM_BIN = fileURLToPath(new URL('../.venv/bin/mlx_lm.generate', import.meta.url));

export interface LocalTextAdapterOptions {
  /** Path to the venv's mlx_lm.generate executable. Defaults to this package's own .venv. */
  readonly mlxLmBin?: string;
  /** Small, fast, ungated (no HuggingFace login needed). */
  readonly model?: string;
  readonly maxTokens?: number;
}

/**
 * Real, local, zero-cost text generation via mlx-lm (runs an open-weight LLM on
 * Apple Silicon through MLX) — the same pattern as the image adapter's mflux.
 * Callers (Director's style brief, Cinematographer's shot plan) instruct the model
 * via `request.prompt`/`request.params.systemPrompt` to return exactly one JSON
 * object; this adapter extracts and parses it. A caller-facing shape mismatch is a
 * prompting problem, not this adapter's — it only guarantees valid JSON came back.
 */
export function createLocalTextAdapter(options: LocalTextAdapterOptions = {}): InferenceAdapter {
  const mlxLmBin = options.mlxLmBin ?? DEFAULT_MLX_LM_BIN;
  const model = options.model ?? 'mlx-community/Qwen2.5-3B-Instruct-4bit';
  const maxTokens = options.maxTokens ?? 400;

  return {
    capability: 'text',

    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const systemPrompt = request.params?.systemPrompt;
      const args = [
        '--model', model,
        '--prompt', request.prompt,
        '--max-tokens', String(maxTokens),
        '--verbose', 'False',
        ...(typeof systemPrompt === 'string' ? ['--system-prompt', systemPrompt] : []),
        ...(request.seed !== undefined ? ['--seed', String(request.seed)] : []),
      ];

      let stdout: string;
      try {
        ({ stdout } = await run(mlxLmBin, args, { maxBuffer: 16 * 1024 * 1024 }));
      } catch (err) {
        throw new InferenceError({
          code: 'TEXT_GENERATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        });
      }

      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start === -1 || end === -1 || end < start) {
        throw new InferenceError({
          code: 'TEXT_NOT_JSON',
          message: `Model output did not contain a JSON object: ${stdout.slice(0, 200)}`,
          retryable: true,
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(stdout.slice(start, end + 1));
      } catch (err) {
        throw new InferenceError({
          code: 'TEXT_NOT_JSON',
          message: `Could not parse model output as JSON: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        });
      }

      return { payload, model, ...(request.seed !== undefined && { seed: request.seed }) };
    },
  };
}
