import { describe, expect, it } from 'vitest';

import { createFakeAdapter, createFakeAdapterRegistry, InferenceError } from '../src/adapter.js';

describe('createFakeAdapter', () => {
  it('echoes the prompt and seed back as the default response', async () => {
    const adapter = createFakeAdapter('image');
    const result = await adapter.generate({ prompt: 'a red barn', seed: 7 });

    expect(result).toEqual({
      payload: { capability: 'image', prompt: 'a red barn', seed: 7 },
      model: 'fake-image',
      seed: 7,
    });
  });

  it('omits seed from the result when the request had none', async () => {
    const adapter = createFakeAdapter('speech');
    const result = await adapter.generate({ prompt: 'hello world' });

    expect(result.seed).toBeUndefined();
    expect(result.payload).toEqual({ capability: 'speech', prompt: 'hello world', seed: null });
  });

  it('uses a custom model name when given one', async () => {
    const adapter = createFakeAdapter('text', { model: 'my-fake-llm' });
    const result = await adapter.generate({ prompt: 'draft a script' });
    expect(result.model).toBe('my-fake-llm');
  });

  it('lets a test script a custom response', async () => {
    const adapter = createFakeAdapter('video', {
      respond: async (request) => ({ payload: `video for ${request.prompt}`, model: 'scripted' }),
    });
    const result = await adapter.generate({ prompt: 'a sunset' });
    expect(result).toEqual({ payload: 'video for a sunset', model: 'scripted' });
  });

  it('lets a test script a failure', async () => {
    const adapter = createFakeAdapter('music', {
      respond: async () => {
        throw new InferenceError({ code: 'RATE_LIMIT', message: 'slow down', retryable: true });
      },
    });
    await expect(adapter.generate({ prompt: 'lofi beat' })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
    });
  });
});

describe('createFakeAdapterRegistry', () => {
  it('wires every capability to an adapter carrying the matching capability field', async () => {
    const registry = createFakeAdapterRegistry();
    for (const capability of ['text', 'image', 'video', 'speech', 'music'] as const) {
      expect(registry.get(capability)?.capability).toBe(capability);
    }
  });

  it('applies per-capability overrides', async () => {
    const registry = createFakeAdapterRegistry({ image: { model: 'special-image-model' } });
    const result = await registry.get('image')?.generate({ prompt: 'x' });
    expect(result?.model).toBe('special-image-model');
    expect(registry.get('text')?.capability).toBe('text');
  });
});
