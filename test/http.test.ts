import { describe, expect, it } from 'vitest';
import { readCapped, type HttpResponseLike } from '../src/http.js';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function bodyless(text: string): HttpResponseLike {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: null,
    text: async () => text,
  };
}

describe('readCapped', () => {
  it('reads a streaming body under the limit', async () => {
    const response: HttpResponseLike = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: streamOf([new TextEncoder().encode('ab'), new TextEncoder().encode('cd')]),
      text: async () => '',
    };
    await expect(readCapped(response, 100)).resolves.toBe('abcd');
  });

  it('allows a body exactly at the limit and rejects one byte over', async () => {
    const atLimit: HttpResponseLike = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: streamOf([new TextEncoder().encode('abc')]),
      text: async () => '',
    };
    await expect(readCapped(atLimit, 3)).resolves.toBe('abc');
    const overLimit: HttpResponseLike = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: streamOf([new TextEncoder().encode('abcd')]),
      text: async () => '',
    };
    await expect(readCapped(overLimit, 3)).rejects.toThrow(/byte limit/i);
  });

  it('falls back to text() for a body-less response', async () => {
    await expect(readCapped(bodyless('small'), 100)).resolves.toBe('small');
    await expect(readCapped(bodyless('x'.repeat(10)), 5)).rejects.toThrow(/byte limit/i);
  });

  it('decodes split multibyte sequences leniently', async () => {
    const encoded = new TextEncoder().encode('héllo');
    const response: HttpResponseLike = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: streamOf([encoded.slice(0, 2), encoded.slice(2)]),
      text: async () => '',
    };
    await expect(readCapped(response, 100)).resolves.toBe('héllo');
  });
});
