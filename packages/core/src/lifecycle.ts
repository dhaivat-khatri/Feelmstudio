/**
 * A project's lifecycle gates whether it is allowed to nag.
 *
 * Without this, a creator who changes a shared voice asset gets a stale flag on every
 * project that ever used it, including dozens already published — and flags that fire
 * on finished work are flags people learn to ignore. The propagation model in PRD
 * §5.3 has no concept of a project being done; this supplies one.
 */
export type ProjectLifecycle = 'draft' | 'active' | 'published' | 'archived';

export const LIFECYCLES: readonly ProjectLifecycle[] = ['draft', 'active', 'published', 'archived'];

/** Only work still in flight competes for the user's attention. */
export const acceptsStalenessFlags = (lifecycle: ProjectLifecycle): boolean =>
  lifecycle === 'draft' || lifecycle === 'active';
