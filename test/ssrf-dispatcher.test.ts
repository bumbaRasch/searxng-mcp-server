import { Agent } from 'undici';
import { describe, expect, it } from 'vitest';
import { createGuardedDispatcher, createGuardedLookup } from '../src/ssrf.js';

type Lookup = ReturnType<typeof createGuardedLookup>;
type CbResult = { err: Error | null; address?: string; family?: number };

function callLookup(
  lookup: Lookup,
  hostname: string,
  opts: { all?: boolean } = {},
): Promise<CbResult> {
  return new Promise((resolve) => {
    lookup(hostname, opts, (err, address, family) => {
      resolve({ err, address: typeof address === 'string' ? address : undefined, family });
    });
  });
}

describe('createGuardedLookup', () => {
  it('returns the resolved public address', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: false,
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    });
    const result = await callLookup(lookup, 'public.test');
    expect(result.err).toBeNull();
    expect(result.address).toBe('8.8.8.8');
    expect(result.family).toBe(4);
  });

  it('rejects a blocked address', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: false,
      lookup: async () => [{ address: '10.0.0.7', family: 4 }],
    });
    const result = await callLookup(lookup, 'internal.test');
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toMatch(/10\.0\.0\.7/);
  });

  it('allows blocked addresses when allowPrivateHosts is true', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const result = await callLookup(lookup, 'localhost');
    expect(result.err).toBeNull();
    expect(result.address).toBe('127.0.0.1');
  });

  it('surfaces resolution errors', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: false,
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const result = await callLookup(lookup, 'missing.test');
    expect(result.err?.message).toMatch(/ENOTFOUND/);
  });

  it('reports a missing address when resolution yields no records', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: false,
      lookup: async () => [],
    });
    const result = await callLookup(lookup, 'empty.test');
    expect(result.err).toBeInstanceOf(Error);
  });

  it('returns all records for the all:true branch', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: false,
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ],
    });
    const records = await new Promise<unknown>((resolve, reject) => {
      lookup('public.test', { all: true }, (error, address) =>
        error ? reject(error) : resolve(address),
      );
    });
    expect(records).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
  });

  it('rejects a blocked address in the all:true branch', async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: false,
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    });
    await expect(
      new Promise((resolve, reject) => {
        lookup('internal.test', { all: true }, (error) => (error ? reject(error) : resolve(null)));
      }),
    ).rejects.toThrow(/10\.0\.0\.1/);
  });
});

describe('createGuardedDispatcher', () => {
  it('returns an undici Agent', () => {
    const dispatcher = createGuardedDispatcher({
      allowPrivateHosts: false,
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    });
    expect(dispatcher).toBeInstanceOf(Agent);
  });
});
