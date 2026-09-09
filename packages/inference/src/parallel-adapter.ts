import { InferenceError } from './adapter.js';

const DEFAULT_BASE_URL = 'https://api.parallel.ai';
const DEFAULT_MAX_RESULTS = 5;

/**
 * Parallel Search processor. Omitted = the API default. `fast` (~700ms) and
 * `turbo` (~200ms) trade depth for latency; `advanced` / `comprehensive` go
 * deeper. Full set as of the v1 API: one-shot, one-shot-new, agentic, fast,
 * parallel, minimal, brave, google, basic, advanced, comprehensive, ngi,
 * private, turbo.
 */
export type ParallelSearchMode =
  | 'one-shot'
  | 'one-shot-new'
  | 'agentic'
  | 'fast'
  | 'parallel'
  | 'minimal'
  | 'brave'
  | 'google'
  | 'basic'
  | 'advanced'
  | 'comprehensive'
  | 'ngi'
  | 'private'
  | 'turbo';

export interface ResearchSource {
  readonly title: string;
  readonly url: string;
}

export interface ResearchResult {
  readonly findings: string[];
  readonly sources: ResearchSource[];
}

export interface ParallelResearchAdapterOptions {
  /** Parallel API key. Falls back to `PARALLEL_API_KEY`. */
  readonly apiKey?: string;
  /** API base. Falls back to `https://api.parallel.ai`. */
  readonly baseUrl?: string;
  /** Test seam — inject a fake `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Cap on results kept (applied client-side; the v1 API has no body param for it). Default 5. */
  readonly maxResults?: number;
  /** Search processor. Omitted from the request unless set. */
  readonly mode?: ParallelSearchMode;
}

export interface ResearchAdapter {
  research(query: string): Promise<ResearchResult>;
}

interface ParallelSearchResponse {
  readonly results?: Array<{ title?: string; url?: string; excerpts?: string[] }>;
}

/**
 * Calls the Parallel Search API (POST /v1/search) and flattens its results into
 * `{ findings, sources }`. Error mapping mirrors `gemini-adapter.ts`: 429 / 5xx
 * retryable, other 4xx not, transport failures (fetch rejects, non-JSON body)
 * retryable. Not an `InferenceAdapter` — the Researcher is a pass-through step,
 * not a graph node, so it isn't routed by the job queue.
 */
export function createParallelResearchAdapter(options: ParallelResearchAdapterOptions = {}): ResearchAdapter {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async research(query: string): Promise<ResearchResult> {
      const apiKey = options.apiKey ?? process.env.PARALLEL_API_KEY;
      if (!apiKey) {
        throw new InferenceError({
          code: 'PARALLEL_API_KEY_MISSING',
          message: 'No Parallel API key: set PARALLEL_API_KEY (or pass { apiKey }).',
          retryable: false,
        });
      }

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({
            objective: query,
            search_queries: [query],
            ...(options.mode && { mode: options.mode }),
          }),
        });
      } catch (err) {
        throw new InferenceError({
          code: 'PARALLEL_UNREACHABLE',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        });
      }

      if (!response.ok) {
        throw new InferenceError({
          code: 'PARALLEL_SEARCH_FAILED',
          message: `Parallel Search returned ${response.status}: ${await safeText(response)}`,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      let body: ParallelSearchResponse;
      try {
        body = (await response.json()) as ParallelSearchResponse;
      } catch (err) {
        throw new InferenceError({
          code: 'PARALLEL_UNREACHABLE',
          message: `Parallel Search response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          cause: err,
        });
      }

      const findings: string[] = [];
      const sources: ResearchSource[] = [];
      for (const r of (body.results ?? []).slice(0, maxResults)) {
        const excerpt = r.excerpts?.find((e) => e.trim().length > 0);
        if (excerpt) findings.push(excerpt.trim());
        if (r.title && r.url) sources.push({ title: r.title, url: r.url });
      }
      return { findings, sources };
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
