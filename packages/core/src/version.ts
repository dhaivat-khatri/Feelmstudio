import type { NodeId, VersionId } from './ids.js';

/**
 * Who produced a version. This gates auto-recompute: a 'derived' node whose current
 * version is user-authored is no longer safe to recompute, because doing so would
 * silently destroy hand edits (Principle #7 — one click shouldn't destroy hours of
 * work). See `isAutoRecomputable` in node.ts.
 */
export type Authorship = 'system' | 'user';

/** A pin to the exact upstream version an artifact was generated from. */
export interface UpstreamRef {
  readonly nodeId: NodeId;
  readonly versionId: VersionId;
}

/**
 * Everything needed to reproduce a generation (PRD §5.2 / Principle #5). Surfaces in
 * the UI as "generated from Script v2, Character v1" provenance text.
 */
export interface Provenance {
  readonly authorship: Authorship;
  readonly upstream: readonly UpstreamRef[];
  readonly prompt?: string;
  readonly seed?: number;
  readonly model?: string;
  /** Set when this version was produced by restoring an earlier one. */
  readonly restoredFrom?: VersionId;
  /** Set when this version was produced by a plain reroll of the version before it. */
  readonly rerollOf?: VersionId;
}

export interface Version<P = unknown> {
  readonly id: VersionId;
  /** 1-based, so the UI can render "version 3 of 4" directly. */
  readonly index: number;
  readonly createdAt: string;
  readonly payload: P;
  readonly provenance: Provenance;
}

export interface NewVersionInput<P = unknown> {
  readonly payload: P;
  readonly authorship: Authorship;
  readonly upstream?: readonly UpstreamRef[];
  readonly prompt?: string;
  readonly seed?: number;
  readonly model?: string;
  readonly restoredFrom?: VersionId;
  readonly rerollOf?: VersionId;
}

export const upstreamRef = (nodeId: NodeId, versionId: VersionId): UpstreamRef => ({
  nodeId,
  versionId,
});

export const sameUpstream = (a: UpstreamRef, b: UpstreamRef): boolean =>
  a.nodeId === b.nodeId && a.versionId === b.versionId;

/** Human-readable provenance line, e.g. "from Script v2, Character v1". */
export function describeUpstream(
  upstream: readonly UpstreamRef[],
  resolve: (id: NodeId) => { label: string; versionIndex: number } | undefined,
): string {
  const parts = upstream.flatMap((ref) => {
    const hit = resolve(ref.nodeId);
    return hit ? [`${hit.label} v${hit.versionIndex}`] : [];
  });
  return parts.length > 0 ? `from ${parts.join(', ')}` : '';
}
