import { describe, expect, it } from 'vitest';

import { NoCurrentVersionError, VersionNotFoundError } from '../src/errors.js';
import { ALL_NODE_KINDS, costsCompute, materialityOf, specOf } from '../src/kinds.js';
import { ArtifactNode } from '../src/node.js';
import { upstreamRef, describeUpstream } from '../src/version.js';
import { id, rt } from './helpers.js';

const node = <P>(kind: Parameters<typeof specOf>[0] = 'sceneImage') =>
  new ArtifactNode<P>({ id: id('n'), kind });

describe('kind classification', () => {
  it('gives every kind a complete spec', () => {
    for (const kind of ALL_NODE_KINDS) {
      const spec = specOf(kind);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(['derived', 'media', 'authored']).toContain(spec.materiality);
    }
  });

  it('treats only media kinds as compute-consuming', () => {
    expect(costsCompute('sceneVideo')).toBe(true);
    expect(costsCompute('narration')).toBe(true);
    // scenePlan is a real Cinematographer LLM call now, not a free echo of scene text.
    expect(costsCompute('scenePlan')).toBe(true);
    expect(costsCompute('sceneScript')).toBe(false);
    expect(costsCompute('script')).toBe(false);
  });

  it('classifies the timeline as derived so it can auto-assemble before the user edits it', () => {
    expect(materialityOf('timeline')).toBe('derived');
  });

  it('classifies imported media as an unconditional source', () => {
    expect(specOf('userMedia').isRoot).toBe(true);
  });
});

describe('ArtifactNode — versions', () => {
  it('starts empty and reports no current version', () => {
    const n = node();
    expect(n.hasVersions).toBe(false);
    expect(n.current).toBeUndefined();
    expect(n.versionCount).toBe(0);
    expect(() => n.requireCurrent()).toThrow(NoCurrentVersionError);
  });

  it('appends versions with 1-based indexes for "v3 of 4" display', () => {
    const n = node<string>();
    const runtime = rt();

    n.addVersion({ payload: 'a', authorship: 'system' }, runtime);
    n.addVersion({ payload: 'b', authorship: 'system' }, runtime);
    const third = n.addVersion({ payload: 'c', authorship: 'system' }, runtime);

    expect(n.versionCount).toBe(3);
    expect(third.index).toBe(3);
    expect(n.current?.payload).toBe('c');
    expect(n.versions.map((v) => v.payload)).toEqual(['a', 'b', 'c']);
  });

  it('never overwrites — regenerating keeps the worse result recoverable', () => {
    const n = node<string>();
    const runtime = rt();

    const good = n.addVersion({ payload: 'good take', authorship: 'system' }, runtime);
    n.addVersion({ payload: 'worse take', authorship: 'system' }, runtime);

    expect(n.current?.payload).toBe('worse take');
    expect(n.versionById(good.id)?.payload).toBe('good take');
  });

  it('records reproducible provenance', () => {
    const n = node<string>();
    const script = upstreamRef(id('script'), 'v_001' as never);

    const v = n.addVersion(
      {
        payload: 'frame.png',
        authorship: 'system',
        upstream: [script],
        prompt: 'wide shot, dusk',
        seed: 42,
        model: 'sdxl-1.0',
      },
      rt(),
    );

    expect(v.provenance).toMatchObject({
      authorship: 'system',
      prompt: 'wide shot, dusk',
      seed: 42,
      model: 'sdxl-1.0',
    });
    expect(v.provenance.upstream).toEqual([script]);
  });

  it('omits optional provenance fields rather than storing undefined', () => {
    const v = node<string>().addVersion({ payload: 'x', authorship: 'user' }, rt());

    expect('seed' in v.provenance).toBe(false);
    expect('prompt' in v.provenance).toBe(false);
    expect(v.provenance.upstream).toEqual([]);
  });

  it('produces deterministic ids and timestamps under the test runtime', () => {
    const n = node<string>();
    const runtime = rt();

    const first = n.addVersion({ payload: 'a', authorship: 'system' }, runtime);
    const second = n.addVersion({ payload: 'b', authorship: 'system' }, runtime);

    expect(first.id).toBe('v_001');
    expect(second.id).toBe('v_002');
    expect(first.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.createdAt).toBe('2026-01-01T00:00:01.000Z');
  });
});

describe('ArtifactNode — restore', () => {
  it('restores additively, so the version being left is still reachable', () => {
    const n = node<string>();
    const runtime = rt();

    const v1 = n.addVersion({ payload: 'original', authorship: 'system' }, runtime);
    const v2 = n.addVersion({ payload: 'regenerated', authorship: 'system' }, runtime);

    const restored = n.restore(v1.id, runtime);

    expect(restored.index).toBe(3);
    expect(restored.payload).toBe('original');
    expect(restored.provenance.restoredFrom).toBe(v1.id);
    expect(n.versionCount).toBe(3);
    expect(n.versionById(v2.id)?.payload).toBe('regenerated');
  });

  it('carries the restored version’s generation parameters forward', () => {
    const n = node<string>();
    const runtime = rt();
    const v1 = n.addVersion(
      { payload: 'a', authorship: 'system', prompt: 'p', seed: 7, model: 'm' },
      runtime,
    );

    const restored = n.restore(v1.id, runtime);

    expect(restored.provenance).toMatchObject({ prompt: 'p', seed: 7, model: 'm' });
  });

  it('rejects an unknown version id', () => {
    const n = node<string>();
    expect(() => n.restore('v_nope', rt())).toThrow(VersionNotFoundError);
  });
});

describe('ArtifactNode — status and failure', () => {
  it('moves a queued node to needsReview once a version lands', () => {
    const n = node<string>();
    n.setStatus('queued');
    n.addVersion({ payload: 'x', authorship: 'system' }, rt());
    expect(n.status).toBe('needsReview');
  });

  it('leaves an approved node approved when a user edits it', () => {
    const n = node<string>();
    n.approve();
    n.addVersion({ payload: 'x', authorship: 'user' }, rt());
    expect(n.status).toBe('approved');
  });

  it('records a failure with a retryable flag and clears it on the next version', () => {
    const n = node<string>();
    const runtime = rt();

    n.fail({ code: 'OOM', message: 'Out of VRAM at 1024x1024', retryable: true }, runtime);

    expect(n.status).toBe('failed');
    expect(n.failure).toMatchObject({ code: 'OOM', retryable: true });

    n.addVersion({ payload: 'recovered', authorship: 'system' }, runtime);

    expect(n.status).toBe('needsReview');
    expect(n.failure).toBeNull();
  });

  it('counts a failure as needing attention', () => {
    const n = node<string>();
    expect(n.needsAttention).toBe(false);
    n.fail({ code: 'X', message: 'y', retryable: false }, rt());
    expect(n.needsAttention).toBe(true);
  });
});

describe('ArtifactNode — auto-recompute gating', () => {
  it('allows auto-recompute for a system-authored derived node', () => {
    const n = new ArtifactNode<string>({ id: id('text'), kind: 'sceneScript' });
    expect(n.isAutoRecomputable).toBe(true);

    n.addVersion({ payload: 'auto', authorship: 'system' }, rt());
    expect(n.isAutoRecomputable).toBe(true);
  });

  /** Journey A, step 7: Maya's timeline trims must survive an upstream change. */
  it('stops auto-recompute the moment a user edits a derived node', () => {
    const n = new ArtifactNode<string>({ id: id('timeline'), kind: 'timeline' });
    n.addVersion({ payload: 'auto-assembled', authorship: 'system' }, rt());

    n.addVersion({ payload: 'hand-trimmed', authorship: 'user' }, rt());

    expect(n.isAutoRecomputable).toBe(false);
  });

  it('never auto-recomputes media or authored nodes', () => {
    const media = new ArtifactNode({ id: id('vid'), kind: 'sceneVideo' });
    const authored = new ArtifactNode({ id: id('script'), kind: 'script' });

    expect(media.isAutoRecomputable).toBe(false);
    expect(authored.isAutoRecomputable).toBe(false);
  });
});

describe('describeUpstream', () => {
  it('renders a provenance line and skips nodes that no longer exist', () => {
    const refs = [
      upstreamRef(id('script'), 'v_002' as never),
      upstreamRef(id('john'), 'v_001' as never),
      upstreamRef(id('deleted'), 'v_009' as never),
    ];

    const line = describeUpstream(refs, (nodeId) =>
      nodeId === id('script')
        ? { label: 'Script', versionIndex: 2 }
        : nodeId === id('john')
          ? { label: 'John', versionIndex: 1 }
          : undefined,
    );

    expect(line).toBe('from Script v2, John v1');
  });

  it('returns an empty string when there is nothing to attribute', () => {
    expect(describeUpstream([], () => undefined)).toBe('');
  });
});
