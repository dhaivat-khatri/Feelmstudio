/** Shared guards for the anime.js-driven decoration layer (marketing site only). */

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const hasFinePointer = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
