import { describe, expect, it } from 'vitest';
import { parseTransportArgv } from '../src/argv.js';

describe('parseTransportArgv', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseTransportArgv([])).toBeUndefined();
    expect(parseTransportArgv(['--other', 'value'])).toBeUndefined();
  });

  it('parses both flag forms', () => {
    expect(parseTransportArgv(['--transport', 'http'])).toBe('http');
    expect(parseTransportArgv(['--transport=stdio'])).toBe('stdio');
  });

  it('finds the flag among other arguments', () => {
    expect(parseTransportArgv(['node', 'index.js', '--transport', 'http', '--verbose'])).toBe(
      'http',
    );
  });

  it('throws on an invalid value', () => {
    expect(() => parseTransportArgv(['--transport', 'grpc'])).toThrow(/expected "stdio" or "http"/);
    expect(() => parseTransportArgv(['--transport=horse'])).toThrow(/"horse"/);
  });

  it('throws when the value is missing', () => {
    expect(() => parseTransportArgv(['--transport'])).toThrow(/got nothing/);
  });
});
