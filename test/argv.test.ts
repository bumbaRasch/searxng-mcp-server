import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliExit, parseTransportArgv } from '../src/argv.js';
import { VERSION } from '../src/version.js';

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

describe('cliExit', () => {
  it('returns undefined when neither flag is present', () => {
    expect(cliExit([], VERSION)).toBeUndefined();
    expect(cliExit(['--transport', 'http'], VERSION)).toBeUndefined();
    expect(cliExit(['--other', 'value'], VERSION)).toBeUndefined();
  });

  it('prints the version to stdout and exits 0 for --version', () => {
    expect(cliExit(['--version'], VERSION)).toEqual({ code: 0, message: VERSION });
  });

  it('prints usage to stdout and exits 0 for --help', () => {
    const exit = cliExit(['--help'], VERSION);
    expect(exit?.code).toBe(0);
    expect(exit?.message).toContain('Usage:');
    for (const flag of ['--transport', '--version', '--help']) {
      expect(exit?.message).toContain(flag);
    }
  });

  it('prefers --help when both flags are present', () => {
    expect(cliExit(['--version', '--help'], VERSION)?.message).toContain('Usage:');
  });
});

describe('main CLI short-circuit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['--help', '--version'] as const)(
    'exits 0 via stdout for %s before any server startup',
    async (flag) => {
      const logs: string[] = [];
      const errors: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((message) => void logs.push(String(message)));
      vi.spyOn(console, 'error').mockImplementation((message) => void errors.push(String(message)));
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit ${String(code)}`);
      });
      const { main } = await import('../src/index.js');
      await expect(main([flag])).rejects.toThrow('process.exit 0');
      expect(logs.join('\n')).toContain(flag === '--help' ? 'Usage:' : VERSION);
      // startup announces itself on stderr — none may happen on a CLI short-circuit
      expect(errors).toEqual([]);
    },
  );
});
