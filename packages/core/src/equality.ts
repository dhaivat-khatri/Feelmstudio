/**
 * Structural equality, used to detect that a recompute produced nothing new.
 *
 * This is load-bearing rather than cosmetic: it is how a whole-script edit stays
 * scoped to the scenes that actually changed. See `propagate`'s pruning path.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;

  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
  );
}
