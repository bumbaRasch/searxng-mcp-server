import { describe, expect, it } from 'vitest';
import { RefRegistry, sharedRefs } from '../src/refs.js';

describe('RefRegistry', () => {
  it('mints stable refs for the same URL and distinct refs for different URLs', () => {
    const refs = new RefRegistry();
    const first = refs.assign('https://a.test/x');
    expect(refs.assign('https://a.test/x')).toBe(first);
    expect(refs.assign('https://b.test/y')).not.toBe(first);
  });

  it('resolves minted refs back to their URL; unknown refs resolve to undefined', () => {
    const refs = new RefRegistry();
    const ref = refs.assign('https://a.test/x');
    expect(refs.resolve(ref)).toBe('https://a.test/x');
    expect(refs.resolve(ref + 1000)).toBeUndefined();
  });

  it('evicts the oldest entry beyond the bound; evicted refs never remap', () => {
    const refs = new RefRegistry(2);
    const a = refs.assign('https://a.test');
    const b = refs.assign('https://b.test');
    const c = refs.assign('https://c.test'); // evicts a
    expect(refs.resolve(a)).toBeUndefined();
    expect(refs.resolve(b)).toBe('https://b.test');
    expect(refs.resolve(c)).toBe('https://c.test');
    // Re-assigning an evicted URL mints a fresh, monotonic ref — never reuses a.
    expect(refs.assign('https://a.test')).toBeGreaterThan(c);
  });

  it('exposes the shared production registry', () => {
    expect(sharedRefs).toBeInstanceOf(RefRegistry);
    const ref = sharedRefs.assign('https://shared.test/session');
    expect(sharedRefs.resolve(ref)).toBe('https://shared.test/session');
  });
});
