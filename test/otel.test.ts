import { describe, expect, it } from 'vitest';
import { fetchContent } from '../src/fetch.js';
import { asFetchLike, HTML_PAGE, makeConfig } from './helpers.js';
import { currentTraceparent, extractTraceparent, runWithTraceContext } from '../src/otel.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
// W3C requires lowercase hex; uppercase is invalid and never forwarded.
const UPPERCASE = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';

describe('extractTraceparent', () => {
  it('accepts lowercase W3C traceparents', () => {
    expect(extractTraceparent({ traceparent: VALID })).toBe(VALID);
    const versionFF = `ff-${'a'.repeat(32)}-${'b'.repeat(16)}-03`;
    expect(extractTraceparent({ traceparent: versionFF })).toBe(versionFF);
  });

  it('rejects malformed, absent or non-string values', () => {
    expect(extractTraceparent(undefined)).toBeUndefined();
    expect(extractTraceparent({})).toBeUndefined();
    expect(extractTraceparent({ traceparent: 'not-a-traceparent' })).toBeUndefined();
    expect(extractTraceparent({ traceparent: 42 })).toBeUndefined();
    expect(extractTraceparent({ traceparent: '00-short-00f067aa0ba902b7-01' })).toBeUndefined();
    expect(extractTraceparent({ traceparent: UPPERCASE })).toBeUndefined();
    expect(extractTraceparent('garbage')).toBeUndefined();
  });
});

describe('runWithTraceContext', () => {
  it('stores the context for nested async reads', async () => {
    expect(currentTraceparent()).toBeUndefined();
    await runWithTraceContext({ traceparent: VALID }, async () => {
      expect(currentTraceparent()).toBe(VALID.toLowerCase());
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentTraceparent()).toBe(VALID.toLowerCase());
    });
    expect(currentTraceparent()).toBeUndefined();
  });

  it('runs without a store when the envelope carries no context', async () => {
    await runWithTraceContext({}, async () => {
      expect(currentTraceparent()).toBeUndefined();
    });
  });
});

describe('traceparent propagation into outbound fetches', () => {
  const config = makeConfig({ allowPrivateHosts: true });
  const seenHeaders: Record<string, string>[] = [];
  const stub = asFetchLike(async (_url: string, init?: { headers?: Record<string, string> }) => {
    seenHeaders.push(init?.headers ?? {});
    return new Response(HTML_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  });

  it('forwards a valid envelope traceparent as the outbound traceparent header', async () => {
    await runWithTraceContext({ traceparent: VALID }, () =>
      fetchContent(config, 'https://x.test/doc', { fetchImpl: stub }),
    );
    expect(seenHeaders.at(-1)?.traceparent).toBe(VALID);
  });

  it('sends no traceparent header outside a trace context', async () => {
    const before = seenHeaders.length;
    await fetchContent(config, 'https://x.test/doc', { fetchImpl: stub });
    expect(seenHeaders).toHaveLength(before + 1);
    expect(seenHeaders.at(-1)?.traceparent).toBeUndefined();
  });
});
