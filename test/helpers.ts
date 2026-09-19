import type { Config } from '../src/config.js';

/** Shared test configuration; per-file defaults can be overridden. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    searxngUrl: 'http://searx.test:8888',
    searxngTimeoutMs: 1000,
    fetchTimeoutMs: 1000,
    maxChars: 10_000,
    maxResponseBytes: 100_000,
    userAgent: 'test/1.0',
    allowPrivateHosts: true, // unit tests skip DNS via injected lookups or literals
    ...overrides,
  };
}

/** JSON Response stub for FetchLike injection. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
