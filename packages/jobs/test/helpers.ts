import { nodeId, projectId, type NodeId, type ProjectId } from '@osai/core';

export const pid = (raw: string): ProjectId => projectId(raw);
export const nid = (raw: string): NodeId => nodeId(raw);

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flushes pending microtasks and one macrotask turn — for racing tick() against setup. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
