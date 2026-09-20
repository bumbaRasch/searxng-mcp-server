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
    expect(cfg.userAgent).toBe('searxng-mcp-server/9.9.9');
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
    expect(loadConfig({ USER_AGENT: '' }, '0.0.0').userAgent).toBe('searxng-mcp-server/0.0.0');
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

describe('config diagnostics', () => {
  it('never logs URL credentials when ignoring an invalid SEARXNG_URL', () => {
    const warnings: string[] = [];
    loadConfig({ SEARXNG_URL: 'ftp://user:secret@host/' }, '1.0.0', (message) =>
      warnings.push(message),
    );
    expect(warnings.join('\n')).not.toContain('secret');
    expect(warnings.join('\n')).toContain('SEARXNG_URL');
  });

  it('warns when a numeric env value is ignored', () => {
    const warnings: string[] = [];
    loadConfig({ MAX_CHARS: 'abc' }, '1.0.0', (message) => warnings.push(message));
    expect(warnings.join('\n')).toMatch(/MAX_CHARS/);
  });

  it('warns when a boolean env value is unrecognized', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ ALLOW_PRIVATE_HOSTS: 'y' }, '1.0.0', (message) =>
      warnings.push(message),
    );
    expect(cfg.allowPrivateHosts).toBe(false);
    expect(warnings.join('\n')).toMatch(/ALLOW_PRIVATE_HOSTS/);
  });

  it('warns and falls back when FETCH_TIMEOUT_MS / MAX_RESPONSE_BYTES are invalid', () => {
    const warnings: string[] = [];
    const cfg = loadConfig(
      { FETCH_TIMEOUT_MS: 'abc', MAX_RESPONSE_BYTES: '0' },
      '0.0.0',
      (message) => warnings.push(message),
    );
    expect(cfg.fetchTimeoutMs).toBe(15_000);
    expect(cfg.maxResponseBytes).toBe(5_242_880);
    expect(warnings.join('\n')).toMatch(/FETCH_TIMEOUT_MS/);
    expect(warnings.join('\n')).toMatch(/MAX_RESPONSE_BYTES/);
  });

  it('accepts yes/on/TRUE and padded variants as boolean true', () => {
    for (const value of ['yes', 'on', ' true ', 'TRUE']) {
      expect(loadConfig({ ALLOW_PRIVATE_HOSTS: value }, '0.0.0').allowPrivateHosts).toBe(true);
    }
  });
});

describe('SHUTDOWN_TIMEOUT_MS', () => {
  it('defaults to 5000', () => {
    expect(loadConfig({}, '1.0.0').shutdownTimeoutMs).toBe(5000);
  });

  it('accepts a valid override', () => {
    expect(loadConfig({ SHUTDOWN_TIMEOUT_MS: '2000' }, '1.0.0').shutdownTimeoutMs).toBe(2000);
  });

  it('warns and falls back on non-numeric values', () => {
    const warnings: string[] = [];
    const config = loadConfig({ SHUTDOWN_TIMEOUT_MS: 'abc' }, '1.0.0', (m) => warnings.push(m));
    expect(config.shutdownTimeoutMs).toBe(5000);
    expect(warnings.join('\n')).toMatch(/SHUTDOWN_TIMEOUT_MS/);
  });

  it('warns and falls back below the 100 ms floor', () => {
    const warnings: string[] = [];
    const config = loadConfig({ SHUTDOWN_TIMEOUT_MS: '50' }, '1.0.0', (m) => warnings.push(m));
    expect(config.shutdownTimeoutMs).toBe(5000);
    expect(warnings.join('\n')).toMatch(/>= 100/);
  });
});
