import { describe, expect, it } from 'vitest';
import {
  assertRecordsAllowed,
  assertUrlAllowed,
  isIpBlocked,
  isUrlSchemeAllowed,
  type AddressRecord,
} from '../src/ssrf.js';

const rec = (address: string, family = 4): AddressRecord => ({ address, family });

describe('isIpBlocked', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['0.0.0.0', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['224.0.0.1', true],
    ['::ffff:127.0.0.1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['2606:4700:4700::1111', false],
    ['::ffff:7f00:1', true],
    ['::ffff:a9fe:a9fe', true],
    ['fe90::1', true],
    ['febf::1', true],
    ['fec0::1', true],
    ['64:ff9b::7f00:1', true],
    ['::ffff:8.8.8.8', true],
  ])('classifies %s as blocked=%s', (ip, blocked) => {
    expect(isIpBlocked(ip)).toBe(blocked);
  });
});

describe('isUrlSchemeAllowed', () => {
  it('allows http and https', () => {
    expect(isUrlSchemeAllowed(new URL('http://x.test'))).toBe(true);
    expect(isUrlSchemeAllowed(new URL('https://x.test'))).toBe(true);
  });
  it('rejects other schemes', () => {
    expect(isUrlSchemeAllowed(new URL('ftp://x.test'))).toBe(false);
    expect(isUrlSchemeAllowed(new URL('file:///etc/passwd'))).toBe(false);
  });
});

describe('assertRecordsAllowed', () => {
  it('throws when any resolved address is blocked', () => {
    expect(() => assertRecordsAllowed('x.test', [rec('8.8.8.8'), rec('10.0.0.1')], false)).toThrow(
      /10\.0\.0\.1/,
    );
  });
  it('passes when allowPrivateHosts is true', () => {
    expect(() => assertRecordsAllowed('x.test', [rec('10.0.0.1')], true)).not.toThrow();
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http(s) and credentialed URLs', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd', { allowPrivateHosts: false })).rejects.toThrow(
      /http/i,
    );
    await expect(
      assertUrlAllowed('http://user:pass@x.test', { allowPrivateHosts: false }),
    ).rejects.toThrow(/credentials/i);
  });

  it('rejects a literal private IP', async () => {
    await expect(
      assertUrlAllowed('http://169.254.169.254/latest', { allowPrivateHosts: false }),
    ).rejects.toThrow(/private/i);
  });

  it('rejects a hostname that resolves to a private IP', async () => {
    const lookup = async () => [rec('10.0.0.5')];
    await expect(
      assertUrlAllowed('http://internal.test', { allowPrivateHosts: false, lookup }),
    ).rejects.toThrow(/internal\.test/);
  });

  it('allows a hostname that resolves to a public IP', async () => {
    const lookup = async () => [rec('8.8.8.8')];
    const url = await assertUrlAllowed('https://public.test/path', {
      allowPrivateHosts: false,
      lookup,
    });
    expect(url.hostname).toBe('public.test');
  });

  it('allows private hosts when explicitly enabled', async () => {
    const url = await assertUrlAllowed('http://localhost:8080', { allowPrivateHosts: true });
    expect(url.hostname).toBe('localhost');
  });

  it('blocks an IPv4-mapped IPv6 URL after normalization', async () => {
    await expect(
      assertUrlAllowed('http://[::ffff:127.0.0.1]/', { allowPrivateHosts: false }),
    ).rejects.toThrow(/private|reserved/i);
  });
});
