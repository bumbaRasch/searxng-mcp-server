import { describe, expect, it } from 'vitest';
import { parseTransportArgv } from '../src/argv.js';
import { assertHttpBindSafety, loadConfig } from '../src/config.js';
import { makeConfig } from './helpers.js';

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
    expect(cfg.transport).toBe('stdio');
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3000);
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.allowedHosts).toEqual([]);
    expect(cfg.allowedOrigins).toEqual([]);
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

  it('parses finite numerics, clamps above the ceiling and rejects Infinity', () => {
    expect(loadConfig({ MAX_CHARS: '900000' }, '0.0.0').maxChars).toBe(900_000);
    expect(loadConfig({ MAX_CHARS: '1e9' }, '0.0.0').maxChars).toBe(1_000_000);
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

describe('SEARXNG_HTML_FALLBACK (D13)', () => {
  it('defaults to false and parses boolean values like the other flags', () => {
    expect(loadConfig({}, '0.0.0').htmlFallback).toBe(false);
    expect(loadConfig({ SEARXNG_HTML_FALLBACK: '1' }, '0.0.0').htmlFallback).toBe(true);
    expect(loadConfig({ SEARXNG_HTML_FALLBACK: 'yes' }, '0.0.0').htmlFallback).toBe(true);
    expect(loadConfig({ SEARXNG_HTML_FALLBACK: 'TRUE' }, '0.0.0').htmlFallback).toBe(true);
    expect(loadConfig({ SEARXNG_HTML_FALLBACK: '0' }, '0.0.0').htmlFallback).toBe(false);
    expect(loadConfig({ SEARXNG_HTML_FALLBACK: 'no' }, '0.0.0').htmlFallback).toBe(false);
    expect(loadConfig({ SEARXNG_HTML_FALLBACK: 'off' }, '0.0.0').htmlFallback).toBe(false);
  });

  it('warns and falls back to false on an unrecognized value', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ SEARXNG_HTML_FALLBACK: 'maybe' }, '1.0.0', (message) =>
      warnings.push(message),
    );
    expect(cfg.htmlFallback).toBe(false);
    expect(warnings.join('\n')).toMatch(/SEARXNG_HTML_FALLBACK/);
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
    expect(warnings.join('\n')).toMatch(/between 100 and 60000/);
  });
});

describe('transport / host / port', () => {
  it('parses SEARXNG_TRANSPORT case-insensitively', () => {
    expect(loadConfig({ SEARXNG_TRANSPORT: 'http' }, '0.0.0').transport).toBe('http');
    expect(loadConfig({ SEARXNG_TRANSPORT: ' STDIO ' }, '0.0.0').transport).toBe('stdio');
  });

  it('warns and falls back to stdio on an invalid transport', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ SEARXNG_TRANSPORT: 'grpc' }, '0.0.0', (m) => warnings.push(m));
    expect(cfg.transport).toBe('stdio');
    expect(warnings.join('\n')).toMatch(/SEARXNG_TRANSPORT/);
  });

  it('accepts PORT within the valid range and rejects out-of-range values', () => {
    expect(loadConfig({ PORT: '8080' }, '0.0.0').port).toBe(8080);
    const warnings: string[] = [];
    expect(loadConfig({ PORT: '70000' }, '0.0.0', (m) => warnings.push(m)).port).toBe(3000);
    expect(loadConfig({ PORT: '0' }, '0.0.0', (m) => warnings.push(m)).port).toBe(3000);
    expect(warnings.join('\n')).toMatch(/between 1 and 65535/);
  });

  it('splits allowlist env values on commas and drops empties', () => {
    const cfg = loadConfig(
      {
        SEARXNG_ALLOWED_HOSTS: 'mcp.example.com, localhost ,',
        SEARXNG_ALLOWED_ORIGINS: 'app.example.com',
      },
      '0.0.0',
    );
    expect(cfg.allowedHosts).toEqual(['mcp.example.com', 'localhost']);
    expect(cfg.allowedOrigins).toEqual(['app.example.com']);
  });

  it('reads SEARXNG_AUTH_TOKEN only when non-blank', () => {
    expect(loadConfig({ SEARXNG_AUTH_TOKEN: 'secret-token' }, '0.0.0').authToken).toBe(
      'secret-token',
    );
    expect(loadConfig({ SEARXNG_AUTH_TOKEN: '   ' }, '0.0.0').authToken).toBeUndefined();
  });
});

describe('non-localhost HTTP bind guard', () => {
  it('refuses a non-localhost bind without an auth token', () => {
    expect(() => loadConfig({ SEARXNG_TRANSPORT: 'http', HOST: '0.0.0.0' }, '0.0.0')).toThrow(
      /SEARXNG_AUTH_TOKEN/,
    );
    expect(() =>
      loadConfig({ SEARXNG_TRANSPORT: 'http', HOST: 'mcp.example.com' }, '0.0.0'),
    ).toThrow(/mcp\.example\.com/);
  });

  it('allows a non-localhost bind with an auth token', () => {
    const cfg = loadConfig(
      { SEARXNG_TRANSPORT: 'http', HOST: '0.0.0.0', SEARXNG_AUTH_TOKEN: 'secret-token' },
      '0.0.0',
    );
    expect(cfg.transport).toBe('http');
    expect(cfg.authToken).toBe('secret-token');
  });

  it('allows localhost binds without a token, and never checks stdio', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      expect(loadConfig({ SEARXNG_TRANSPORT: 'http', HOST: host }, '0.0.0').host).toBe(host);
    }
    expect(loadConfig({ HOST: '0.0.0.0' }, '0.0.0').transport).toBe('stdio');
  });

  it('does not leak the auth token in the thrown message', () => {
    let message = '';
    try {
      loadConfig(
        { SEARXNG_TRANSPORT: 'http', HOST: '0.0.0.0', SEARXNG_AUTH_TOKEN: '   ' },
        '0.0.0',
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('   ');
  });
});

describe('assertHttpBindSafety (effective transport)', () => {
  it('refuses the flag-transport bypass: --transport http on a non-localhost bind without a token', () => {
    const config = { ...makeConfig(), host: '0.0.0.0' };
    const viaFlag = parseTransportArgv(['--transport', 'http']);
    expect(viaFlag).toBe('http');
    expect(() => assertHttpBindSafety(viaFlag ?? 'stdio', config)).toThrow(/SEARXNG_AUTH_TOKEN/);
  });

  it('allows the same bind with an auth token, localhost without one, and stdio always', () => {
    const exposed = { ...makeConfig(), host: '0.0.0.0', authToken: 't' };
    expect(() => assertHttpBindSafety('http', exposed)).not.toThrow();
    expect(() =>
      assertHttpBindSafety('http', { ...makeConfig(), host: '127.0.0.1' }),
    ).not.toThrow();
    expect(() => assertHttpBindSafety('stdio', { ...makeConfig(), host: '0.0.0.0' })).not.toThrow();
  });
});

describe('SEARXNG_URLS / SEARXNG_CACHE_TTL_MS (B6)', () => {
  it('defaults to a primary-only instance list and caching off', () => {
    const cfg = loadConfig({}, '0.0.0');
    expect(cfg.searxngUrls).toEqual(['http://localhost:8888']);
    expect(cfg.cacheTtlMs).toBe(0);
  });

  it('extends SEARXNG_URL with SEARXNG_URLS entries; the primary stays first', () => {
    const cfg = loadConfig(
      {
        SEARXNG_URL: 'http://a.test:8888/',
        SEARXNG_URLS: ' http://b.test:8888 , http://c.test:8888/searxng///',
      },
      '0.0.0',
    );
    expect(cfg.searxngUrl).toBe('http://a.test:8888');
    expect(cfg.searxngUrls).toEqual([
      'http://a.test:8888',
      'http://b.test:8888',
      'http://c.test:8888/searxng',
    ]);
  });

  it('warns and skips invalid entries and strips embedded credentials', () => {
    const warnings: string[] = [];
    const cfg = loadConfig(
      {
        SEARXNG_URL: 'http://a.test',
        SEARXNG_URLS: 'ftp://bad.test, http://u:sekret@b.test, not a url ,,http://a.test',
      },
      '0.0.0',
      (message) => warnings.push(message),
    );
    expect(cfg.searxngUrls).toEqual(['http://a.test', 'http://b.test']);
    expect(warnings.filter((warning) => warning.includes('SEARXNG_URLS'))).toHaveLength(2);
    expect(warnings.join('\n')).toContain('only http/https are supported');
    expect(warnings.join('\n')).toContain('not a valid URL');
    expect(warnings.join('\n')).not.toContain('sekret');
  });

  it('drops duplicate instances (primary repeats and list repeats)', () => {
    const cfg = loadConfig(
      { SEARXNG_URL: 'http://a.test', SEARXNG_URLS: 'http://a.test/,http://b.test,http://b.test' },
      '0.0.0',
    );
    expect(cfg.searxngUrls).toEqual(['http://a.test', 'http://b.test']);
  });

  it('ignores a blank SEARXNG_URLS without warnings', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ SEARXNG_URLS: '  ' }, '0.0.0', (message) => warnings.push(message));
    expect(cfg.searxngUrls).toEqual(['http://localhost:8888']);
    expect(warnings).toHaveLength(0);
  });

  it('parses SEARXNG_CACHE_TTL_MS and falls back to 0 on invalid values', () => {
    expect(loadConfig({ SEARXNG_CACHE_TTL_MS: '250' }, '0.0.0').cacheTtlMs).toBe(250);
    expect(loadConfig({ SEARXNG_CACHE_TTL_MS: '0' }, '0.0.0').cacheTtlMs).toBe(0);
    const warnings: string[] = [];
    const cfg = loadConfig({ SEARXNG_CACHE_TTL_MS: '-5' }, '0.0.0', (message) =>
      warnings.push(message),
    );
    expect(cfg.cacheTtlMs).toBe(0);
    expect(warnings.join('\n')).toMatch(/SEARXNG_CACHE_TTL_MS/);
  });
});

describe('config ceilings (warn + clamp)', () => {
  it('clamps above-ceiling values with one warning each', () => {
    const warnings: string[] = [];
    const cfg = loadConfig(
      {
        SEARXNG_TIMEOUT_MS: '999999',
        FETCH_TIMEOUT_MS: '999999',
        SHUTDOWN_TIMEOUT_MS: '999999',
        MAX_CHARS: '2000000',
        MAX_RESPONSE_BYTES: '104857601',
        SEARXNG_CACHE_TTL_MS: '86400001',
      },
      '0.0.0',
      (message) => warnings.push(message),
    );
    expect(cfg.searxngTimeoutMs).toBe(300_000);
    expect(cfg.fetchTimeoutMs).toBe(300_000);
    expect(cfg.shutdownTimeoutMs).toBe(60_000);
    expect(cfg.maxChars).toBe(1_000_000);
    expect(cfg.maxResponseBytes).toBe(104_857_600);
    expect(cfg.cacheTtlMs).toBe(86_400_000);
    expect(warnings).toHaveLength(6);
    expect(warnings.join('\n')).toContain('clamping');
  });

  it('accepts values exactly at the ceiling without warnings', () => {
    const warnings: string[] = [];
    const cfg = loadConfig(
      {
        SEARXNG_TIMEOUT_MS: '300000',
        FETCH_TIMEOUT_MS: '300000',
        SHUTDOWN_TIMEOUT_MS: '60000',
        MAX_CHARS: '1000000',
        MAX_RESPONSE_BYTES: '104857600',
        SEARXNG_CACHE_TTL_MS: '86400000',
      },
      '0.0.0',
      (message) => warnings.push(message),
    );
    expect(cfg.searxngTimeoutMs).toBe(300_000);
    expect(cfg.fetchTimeoutMs).toBe(300_000);
    expect(cfg.shutdownTimeoutMs).toBe(60_000);
    expect(cfg.maxChars).toBe(1_000_000);
    expect(cfg.maxResponseBytes).toBe(104_857_600);
    expect(cfg.cacheTtlMs).toBe(86_400_000);
    expect(warnings).toHaveLength(0);
  });

  it('keeps the warn-and-fallback path for negative and sub-minimum values', () => {
    const warnings: string[] = [];
    const cfg = loadConfig(
      { MAX_CHARS: '-5', SEARXNG_TIMEOUT_MS: '0', SHUTDOWN_TIMEOUT_MS: '50' },
      '0.0.0',
      (message) => warnings.push(message),
    );
    expect(cfg.maxChars).toBe(25_000);
    expect(cfg.searxngTimeoutMs).toBe(10_000);
    expect(cfg.shutdownTimeoutMs).toBe(5_000);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('ignoring');
  });

  it('does not clamp PORT: out-of-range still falls back to the default', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ PORT: '999999' }, '0.0.0', (message) => warnings.push(message));
    expect(cfg.port).toBe(3000);
    expect(warnings.join('\n')).toMatch(/between 1 and 65535/);
  });
});

describe('SEARXNG_USERNAME without SEARXNG_PASSWORD', () => {
  it('warns once and never logs the username', () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ SEARXNG_USERNAME: 'alice' }, '0.0.0', (message) =>
      warnings.push(message),
    );
    expect(cfg.searxngUsername).toBe('alice');
    expect(cfg.searxngPassword).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SEARXNG_USERNAME');
    expect(warnings.join('\n')).not.toContain('alice');
  });

  it('stays silent when both credentials are set or neither is', () => {
    const warnings: string[] = [];
    loadConfig({ SEARXNG_USERNAME: 'alice', SEARXNG_PASSWORD: 'p' }, '0.0.0', (message) =>
      warnings.push(message),
    );
    loadConfig({}, '0.0.0', (message) => warnings.push(message));
    expect(warnings).toHaveLength(0);
  });
});
