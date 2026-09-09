import { describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createParallelResearchAdapter } from '../src/parallel-adapter.js';

/**
 * The Parallel Search adapter is unit-tested with an injected `fetchImpl` — no
 * network, no API key. Shape verified against docs.parallel.ai/search-api
 * (POST https://api.parallel.ai/v1/search, `x-api-key` header, response
 * `{ results: [{ url, title, excerpts }] }`). Live calls are smoke-tested
 * manually, see packages/inference/README.md.
 */
const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('createParallelResearchAdapter', () => {
  it('POSTs objective + search_queries with the x-api-key header and parses results', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          search_id: 'srch_1',
          results: [
            { url: 'https://example.com/a', title: 'Lighthouse history', publish_date: '1998-01-01', excerpts: ['Keepers were replaced by automation in the 1990s.'] },
            { url: 'https://example.com/b', title: 'Fresnel lenses', publish_date: null, excerpts: ['The lens focuses light into a single beam.'] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const adapter = createParallelResearchAdapter({ apiKey: 'k-123', fetchImpl });
    const result = await adapter.research('facts about lighthouse keepers');

    expect(seen?.url).toBe('https://api.parallel.ai/v1/search');
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k-123');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(seen?.init.body));
    expect(body).toMatchObject({
      objective: 'facts about lighthouse keepers',
      search_queries: ['facts about lighthouse keepers'],
    });

    expect(result.findings).toEqual([
      'Keepers were replaced by automation in the 1990s.',
      'The lens focuses light into a single beam.',
    ]);
    expect(result.sources).toEqual([
      { title: 'Lighthouse history', url: 'https://example.com/a' },
      { title: 'Fresnel lenses', url: 'https://example.com/b' },
    ]);
  });

  it('returns empty findings/sources (not a throw) when there are no results', async () => {
    const adapter = createParallelResearchAdapter({ apiKey: 'k', fetchImpl: fakeFetch(200, { search_id: 's', results: [] }) });
    await expect(adapter.research('q')).resolves.toEqual({ findings: [], sources: [] });
  });

  it('skips a result with no usable excerpt but still keeps its source', async () => {
    const adapter = createParallelResearchAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch(200, {
        results: [
          { url: 'https://x/1', title: 'No excerpt', excerpts: [] },
          { url: 'https://x/2', title: 'Has one', excerpts: ['  ', 'a real finding'] },
        ],
      }),
    });
    await expect(adapter.research('q')).resolves.toEqual({
      findings: ['a real finding'],
      sources: [
        { title: 'No excerpt', url: 'https://x/1' },
        { title: 'Has one', url: 'https://x/2' },
      ],
    });
  });

  it('throws a non-retryable InferenceError when the api key is missing', async () => {
    const adapter = createParallelResearchAdapter({ apiKey: '', fetchImpl: fakeFetch(200, { results: [] }) });
    await expect(adapter.research('q')).rejects.toMatchObject({ code: 'PARALLEL_API_KEY_MISSING', retryable: false });
  });

  it('maps 429 and 5xx to retryable, other 4xx to non-retryable', async () => {
    const on = (status: number) =>
      createParallelResearchAdapter({ apiKey: 'k', fetchImpl: fakeFetch(status, { error: 'x' }) }).research('q');

    await expect(on(429)).rejects.toMatchObject({ code: 'PARALLEL_SEARCH_FAILED', retryable: true });
    await expect(on(503)).rejects.toMatchObject({ code: 'PARALLEL_SEARCH_FAILED', retryable: true });
    await expect(on(400)).rejects.toMatchObject({ code: 'PARALLEL_SEARCH_FAILED', retryable: false });
    await expect(on(401)).rejects.toBeInstanceOf(InferenceError);
  });

  it('treats a transport failure (fetch rejects) as retryable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const adapter = createParallelResearchAdapter({ apiKey: 'k', fetchImpl });
    await expect(adapter.research('q')).rejects.toMatchObject({ code: 'PARALLEL_UNREACHABLE', retryable: true });
  });

  it('treats a non-JSON body as a retryable transport failure', async () => {
    const fetchImpl = (async () =>
      new Response('<html>gateway timeout</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const adapter = createParallelResearchAdapter({ apiKey: 'k', fetchImpl });
    await expect(adapter.research('q')).rejects.toMatchObject({ code: 'PARALLEL_UNREACHABLE', retryable: true });
  });

  it('sends mode in the body when set, and never sends max_results (not a v1 param)', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    await createParallelResearchAdapter({ apiKey: 'k', fetchImpl, mode: 'fast' }).research('q');
    expect(body).toMatchObject({ mode: 'fast' });
    expect(body).not.toHaveProperty('max_results');
  });

  it('caps kept results at maxResults, client-side', async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ url: `https://x/${i}`, title: `t${i}`, excerpts: [`finding ${i}`] }));
    const adapter = createParallelResearchAdapter({ apiKey: 'k', fetchImpl: fakeFetch(200, { results }), maxResults: 3 });
    const r = await adapter.research('q');
    expect(r.findings).toEqual(['finding 0', 'finding 1', 'finding 2']);
    expect(r.sources).toHaveLength(3);
  });
});
