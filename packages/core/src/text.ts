/** Small text-similarity helpers used by segmentation matching. Unicode-aware. */

const WORD_SPLIT = /\s+/;
const NON_WORD = /[^\p{L}\p{N}\s]/gu;

export function tokenize(text: string): readonly string[] {
  return text.toLowerCase().replace(NON_WORD, ' ').split(WORD_SPLIT).filter(Boolean);
}

export function tokenSet(text: string): ReadonlySet<string> {
  return new Set(tokenize(text));
}

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const token of small) if (large.has(token)) n += 1;
  return n;
}

/** Symmetric overlap. Two empty texts are identical; one empty text matches nothing. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersectionSize(a, b);
  return shared / (a.size + b.size - shared);
}

/** How much of `sub` appears inside `sup` — asymmetric, drives split/merge detection. */
export function containment(sub: ReadonlySet<string>, sup: ReadonlySet<string>): number {
  if (sub.size === 0) return 0;
  return intersectionSize(sub, sup) / sub.size;
}

/** Whitespace-insensitive equality, so reflowing a paragraph is not a content change. */
export function sameText(a: string, b: string): boolean {
  return a.trim().replace(WORD_SPLIT, ' ') === b.trim().replace(WORD_SPLIT, ' ');
}
