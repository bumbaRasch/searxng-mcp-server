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
    expect(loadConfig({ SEARXNG_URL: 'http://searx.test:8888///' }).searxngUrl).toBe(
      'http://searx.test:8888',
    );
  });

  it('falls back to defaults on invalid numbers', () => {
    const cfg = loadConfig({ SEARXNG_TIMEOUT_MS: 'abc', MAX_CHARS: '-5' });
    expect(cfg.searxngTimeoutMs).toBe(10_000);
    expect(cfg.maxChars).toBe(25_000);
  });

  it('parses a positive integer override', () => {
    expect(loadConfig({ MAX_CHARS: '1000' }).maxChars).toBe(1000);
  });

  it('parses boolean-like env values', () => {
    expect(loadConfig({ ALLOW_PRIVATE_HOSTS: 'true' }).allowPrivateHosts).toBe(true);
    expect(loadConfig({ ALLOW_PRIVATE_HOSTS: '1' }).allowPrivateHosts).toBe(true);
    expect(loadConfig({ ALLOW_PRIVATE_HOSTS: 'no' }).allowPrivateHosts).toBe(false);
  });

  it('reads optional basic-auth credentials', () => {
    const cfg = loadConfig({ SEARXNG_USERNAME: 'u', SEARXNG_PASSWORD: 'p' });
    expect(cfg.searxngUsername).toBe('u');
    expect(cfg.searxngPassword).toBe('p');
  });

  it('honors a custom USER_AGENT', () => {
    expect(loadConfig({ USER_AGENT: 'custom/1' }).userAgent).toBe('custom/1');
  });

  it('falls back when URL / USER_AGENT are blank or slash-only', () => {
    expect(loadConfig({ SEARXNG_URL: '   ' }).searxngUrl).toBe('http://localhost:8888');
    expect(loadConfig({ SEARXNG_URL: '/' }).searxngUrl).toBe('http://localhost:8888');
    expect(loadConfig({ USER_AGENT: '' }).userAgent).toBe('searxng-mcp-ts/0.0.0');
  });
});
