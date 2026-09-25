import type { Config } from '../src/config.js';
import type { FetchLike } from '../src/http.js';

/** Shared article fixture: long enough to survive Readability extraction. */
export const HTML_PAGE = `<!doctype html><html><head><title>Doc</title></head><body>
  <article><h1>Doc</h1><p>${'word '.repeat(300)}</p></article></body></html>`;

/** Cast a plain mock function to FetchLike without the double-assertion dance. */
export function asFetchLike(fn: unknown): FetchLike {
  return fn as FetchLike;
}

/** Shared test configuration; per-file defaults can be overridden. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    transport: 'stdio',
    searxngUrl: 'http://searx.test:8888',
    searxngUrls: ['http://searx.test:8888'],
    searxngTimeoutMs: 1000,
    cacheTtlMs: 0,
    fetchTimeoutMs: 1000,
    shutdownTimeoutMs: 5000,
    maxChars: 10_000,
    maxResponseBytes: 100_000,
    userAgent: 'test/1.0',
    allowPrivateHosts: true, // unit tests skip DNS via injected lookups or literals
    host: '127.0.0.1',
    port: 0, // ephemeral: every use listens on its own free port
    allowedHosts: [],
    allowedOrigins: [],
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
