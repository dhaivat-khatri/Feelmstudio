import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InferenceError } from '../src/adapter.js';
import { createLocalTextAdapter } from '../src/local-text-adapter.js';

describe('createLocalTextAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osai-inference-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeStubMlxLm(script: string): Promise<string> {
    const path = join(dir, 'stub-mlx-lm.sh');
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it('extracts and parses a JSON object from the model output', async () => {
    const mlxLmBin = await writeStubMlxLm('echo \'{"tone":"tense","palette":"cool"}\'');
    const adapter = createLocalTextAdapter({ mlxLmBin });

    const result = await adapter.generate({ prompt: 'describe the mood' });

    expect(result.payload).toEqual({ tone: 'tense', palette: 'cool' });
  });

  it('extracts JSON even when the model wraps it in prose', async () => {
    const mlxLmBin = await writeStubMlxLm('echo \'Sure! Here you go: {"tone":"warm"} Hope that helps.\'');
    const adapter = createLocalTextAdapter({ mlxLmBin });

    const result = await adapter.generate({ prompt: 'describe the mood' });

    expect(result.payload).toEqual({ tone: 'warm' });
  });

  it('throws a retryable InferenceError when the output has no JSON object', async () => {
    const mlxLmBin = await writeStubMlxLm('echo "I cannot help with that."');
    const adapter = createLocalTextAdapter({ mlxLmBin });

    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'TEXT_NOT_JSON',
      retryable: true,
    });
  });

  it('throws a retryable InferenceError when the CLI fails', async () => {
    const mlxLmBin = await writeStubMlxLm('echo "boom" >&2; exit 1');
    const adapter = createLocalTextAdapter({ mlxLmBin });

    await expect(adapter.generate({ prompt: 'x' })).rejects.toBeInstanceOf(InferenceError);
    await expect(adapter.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'TEXT_GENERATION_FAILED',
      retryable: true,
    });
  });
});
