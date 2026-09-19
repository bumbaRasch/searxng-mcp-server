import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const cfg = loadConfig({}, '9.9.9');
    expect(cfg.searxngUrl).toBe('http://localhost:8888');
    expect(cfg.searxngTimeoutMs).toBe(10_000);
    expect(cfg.fetchTimeoutMs).toBe(15_000);
    expect(cfg.maxChars).toBe(25_000);
    expect(cfg.maxResponseBytes).toBe(5_242_880);
    expect(cfg.userAgent).toBe('searxng-mcp-ts/9.9.9');
    expect(cfg.allowPrivateHosts).toBe(false);
    expect(cfg.searxngUsername).toBeUndefined();
  });

  it('strips trailing slashes from the SearXNG URL', () => {
    expect(loadConfig({ SEARXNG_URL: 'http://searx.test:8888///' }, '0.0.0').searxngUrl).toBe(
      'http://searx.test:8888',
    );
  });

  it('falls back to defaults on invalid numbers', () => {
    const cfg = loadConfig({ SEARXNG_TIMEOUT_MS: 'abc', MAX_CHARS: '-5' }, '0.0.0');
    expect(cfg.searxngTimeoutMs).toBe(10_000);
    expect(cfg.maxChars).toBe(25_000);
  });

  it('parses a positive integer override', () => {
    expect(loadConfig({ MAX_CHARS: '1000' }, '0.0.0').maxChars).toBe(1000);
  });

  it('parses boolean-like env values', () => {
    expect(loadConfig({ ALLOW_PRIVATE_HOSTS: 'true' }, '0.0.0').allowPrivateHosts).toBe(true);
    expect(loadConfig({ ALLOW_PRIVATE_HOSTS: '1' }, '0.0.0').allowPrivateHosts).toBe(true);
    expect(loadConfig({ ALLOW_PRIVATE_HOSTS: 'no' }, '0.0.0').allowPrivateHosts).toBe(false);
  });

  it('reads optional basic-auth credentials', () => {
    const cfg = loadConfig({ SEARXNG_USERNAME: 'u', SEARXNG_PASSWORD: 'p' }, '0.0.0');
    expect(cfg.searxngUsername).toBe('u');
    expect(cfg.searxngPassword).toBe('p');
  });

  it('honors a custom USER_AGENT', () => {
    expect(loadConfig({ USER_AGENT: 'custom/1' }, '0.0.0').userAgent).toBe('custom/1');
  });

  it('falls back when URL / USER_AGENT are blank or slash-only', () => {
    expect(loadConfig({ SEARXNG_URL: '   ' }, '0.0.0').searxngUrl).toBe('http://localhost:8888');
    expect(loadConfig({ SEARXNG_URL: '/' }, '0.0.0').searxngUrl).toBe('http://localhost:8888');
    expect(loadConfig({ USER_AGENT: '' }, '0.0.0').userAgent).toBe('searxng-mcp-ts/0.0.0');
  });

  it('treats 0 as invalid for positive numeric values', () => {
    expect(loadConfig({ MAX_CHARS: '0' }, '0.0.0').maxChars).toBe(25_000);
    expect(loadConfig({ SEARXNG_TIMEOUT_MS: '0' }, '0.0.0').searxngTimeoutMs).toBe(10_000);
  });

  it('sanitizes credentials and non-http(s) schemes out of SEARXNG_URL', () => {
    expect(loadConfig({ SEARXNG_URL: 'http://u:p@searx.test:8888' }, '0.0.0').searxngUrl).toBe(
      'http://searx.test:8888',
    );
    expect(loadConfig({ SEARXNG_URL: 'ftp://searx.test' }, '0.0.0').searxngUrl).toBe(
      'http://localhost:8888',
    );
    expect(loadConfig({ SEARXNG_URL: 'not a url' }, '0.0.0').searxngUrl).toBe(
      'http://localhost:8888',
    );
  });

  it('preserves a non-root path in SEARXNG_URL', () => {
    expect(loadConfig({ SEARXNG_URL: 'http://searx.test:8888/searxng/' }, '0.0.0').searxngUrl).toBe(
      'http://searx.test:8888/searxng',
    );
  });

  it('warns on stderr when SEARXNG_URL is invalid and falls back', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ SEARXNG_URL: 'htp://typo' }, '0.0.0', (m) => warnings.push(m));
    expect(cfg.searxngUrl).toBe('http://localhost:8888');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SEARXNG_URL');
    loadConfig({}, '0.0.0', (m) => warnings.push(m));
    expect(warnings).toHaveLength(1); // no warning when unset
  });

  it('accepts very large finite numerics and rejects Infinity', () => {
    expect(loadConfig({ MAX_CHARS: '1e9' }, '0.0.0').maxChars).toBe(1e9);
    expect(loadConfig({ MAX_CHARS: 'Infinity' }, '0.0.0').maxChars).toBe(25_000);
    expect(loadConfig({ MAX_CHARS: ' 5000 ' }, '0.0.0').maxChars).toBe(5000);
  });
});
