/**
 * Ambient dependencies (time, identity) are injected rather than imported so the
 * whole domain core is deterministic under test. Provenance records timestamps and
 * ids; if those were ambient, no version-history assertion could be exact.
 */

export interface Clock {
  now(): string;
}

export interface IdSource {
  next(prefix: string): string;
}

export interface Runtime {
  readonly clock: Clock;
  readonly ids: IdSource;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** Advances a fixed amount on every read, so ordering is observable in tests. */
export function fixedClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let t = Date.parse(startIso);
  if (Number.isNaN(t)) throw new TypeError(`fixedClock: invalid start "${startIso}"`);
  return {
    now: () => {
      const iso = new Date(t).toISOString();
      t += stepMs;
      return iso;
    },
  };
}

export function counterIdSource(): IdSource {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(3, '0')}`;
    },
  };
}

export function randomIdSource(): IdSource {
  return {
    next: (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
  };
}

export const systemRuntime = (): Runtime => ({ clock: systemClock, ids: randomIdSource() });

/** Deterministic runtime for tests and for reproducing a generation exactly. */
export const testRuntime = (startIso?: string, stepMs?: number): Runtime => ({
  clock: fixedClock(startIso, stepMs),
  ids: counterIdSource(),
});
