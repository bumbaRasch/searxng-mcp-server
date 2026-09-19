import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type AddressRecord = { address: string; family: number };
export type LookupAll = (hostname: string) => Promise<AddressRecord[]>;

const defaultLookup: LookupAll = async (hostname) => dnsLookup(hostname, { all: true });

const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
const V4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [net, prefix] of V4_RANGES) BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
const V6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['::', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V6_RANGES) BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

function normalizeIp(ip: string): { address: string; family: number } | null {
  let address = ip.trim().toLowerCase();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const family = isIP(address);
  return family === 0 ? null : { address, family };
}

export function isIpBlocked(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (normalized === null) return false;
  try {
    return normalized.family === 4
      ? BLOCKED_V4.check(normalized.address, 'ipv4')
      : BLOCKED_V6.check(normalized.address, 'ipv6');
  } catch {
    return true; // fail closed on unparseable input
  }
}

export function isUrlSchemeAllowed(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export function assertRecordsAllowed(
  host: string,
  records: AddressRecord[],
  allowPrivateHosts: boolean,
): void {
  if (allowPrivateHosts) return;
  for (const record of records) {
    if (isIpBlocked(record.address)) {
      throw new Error(
        `Refusing to fetch "${host}": it resolves to a private or reserved address (${record.address}).`,
      );
    }
  }
}

export async function assertUrlAllowed(
  rawUrl: string,
  opts: { allowPrivateHosts: boolean; lookup?: LookupAll },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (!isUrlSchemeAllowed(url)) {
    throw new Error(`Only http and https URLs are allowed, got "${url.protocol}".`);
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }
  if (opts.allowPrivateHosts) return url;

  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(literal)) {
    assertRecordsAllowed(url.hostname, [{ address: literal, family: isIP(literal) }], false);
    return url;
  }

  const lookup = opts.lookup ?? defaultLookup;
  let records: AddressRecord[];
  try {
    records = await lookup(url.hostname);
  } catch (error) {
    throw new Error(`Could not resolve host "${url.hostname}".`, { cause: error });
  }
  if (records.length === 0) {
    throw new Error(`Could not resolve host "${url.hostname}".`);
  }
  assertRecordsAllowed(url.hostname, records, false);
  return url;
}
