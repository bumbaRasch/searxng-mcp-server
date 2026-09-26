export type Transport = 'stdio' | 'http';

export interface Config {
  transport: Transport;
  searxngUrl: string;
  /** Failover instances after `searxngUrl`, in try order (`SEARXNG_URLS`); the primary is always first. */
  searxngUrls: string[];
  searxngUsername?: string;
  searxngPassword?: string;
  searxngTimeoutMs: number;
  /** Response cache TTL in ms (`SEARXNG_CACHE_TTL_MS`); 0 disables caching (default, D9). */
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxChars: number;
  maxResponseBytes: number;
  userAgent: string;
  allowPrivateHosts: boolean;
  /** HTTP transport: interface to bind (`HOST`). */
  host: string;
  /** HTTP transport: port to listen on (`PORT`). */
  port: number;
  /** HTTP transport: static bearer token (`SEARXNG_AUTH_TOKEN`); required for non-localhost binds, never logged. */
  authToken?: string;
  /** HTTP transport: extra `Host` hostnames beyond the localhost allowlist (`SEARXNG_ALLOWED_HOSTS`). */
  allowedHosts: string[];
  /** HTTP transport: extra `Origin` hostnames beyond the localhost allowlist (`SEARXNG_ALLOWED_ORIGINS`). */
  allowedOrigins: string[];
  /** Retry JSON-disabled instances via their HTML UI for `search` (`SEARXNG_HTML_FALLBACK`, D13). */
  htmlFallback: boolean;
  /** Applied when a search request omits `language` (`SEARXNG_DEFAULT_LANGUAGE`, D16). */
  defaultLanguage?: string;
  /** Applied when a search request omits `safesearch` (`SEARXNG_DEFAULT_SAFESEARCH`, D16). */
  defaultSafesearch?: 0 | 1 | 2;
  /** Ceiling on request `max_results`; larger requests clamp (`SEARXNG_MAX_RESULTS`, D16). */
  maxResults?: number;
}

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const DEFAULT_SEARXNG_URL = 'http://localhost:8888';
const DEFAULT_SEARXNG_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 0;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 25_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 100;
/** Ceilings (warn + clamp) keeping a stray env value from wedging the server. */
const MAX_SEARXNG_TIMEOUT_MS = 300_000;
const MAX_FETCH_TIMEOUT_MS = 300_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;
const MAX_MAX_CHARS = 1_000_000;
const MAX_MAX_RESPONSE_BYTES = 104_857_600;
const MAX_CACHE_TTL_MS = 86_400_000;
const DEFAULT_TRANSPORT: Transport = 'stdio';
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 3000;
const MAX_PORT = 65_535;
/** Hosts considered local: only these may serve HTTP without an auth token. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Integer env read. Above `max` the value warns and CLAMPS to the ceiling,
 * unless `clamp` is false (then it falls back like any other invalid value). */
function intEnv(
  env: Env,
  key: string,
  fallback: number,
  warn: Warn,
  min = 1,
  max = Number.POSITIVE_INFINITY,
  clamp = true,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const range = max === Number.POSITIVE_INFINITY ? `>= ${min}` : `between ${min} and ${max}`;
  if (!Number.isFinite(value) || value < min || (value > max && !clamp)) {
    warn(`${key}: ignoring "${raw.trim()}" (expected an integer ${range}), using ${fallback}`);
    return fallback;
  }
  if (value > max) {
    warn(`${key}: clamping "${raw.trim()}" to ${max}`);
    return max;
  }
  return Math.floor(value);
}

function boolEnv(env: Env, key: string, fallback: boolean, warn: Warn): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())) return false;
  warn(
    `${key}: ignoring "${raw.trim()}" (expected 1/true/yes/on or 0/false/no/off), using ${fallback}`,
  );
  return fallback;
}

/** Optional integer env read (unset when absent); invalid values warn and unset. */
function optionalIntEnv(env: Env, key: string, warn: Warn, min: number): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    warn(`${key}: ignoring "${raw.trim()}" (expected an integer >= ${min}), unset`);
    return undefined;
  }
  return Math.floor(value);
}

/** `SEARXNG_DEFAULT_SAFESEARCH`: 0|1|2; anything else warns and stays unset (D16). */
function safesearchDefaultEnv(env: Env, warn: Warn): 0 | 1 | 2 | undefined {
  const raw = env.SEARXNG_DEFAULT_SAFESEARCH?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  warn(`SEARXNG_DEFAULT_SAFESEARCH: ignoring "${raw}" (expected 0, 1 or 2), unset`);
  return undefined;
}

function strEnv(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

/** WHATWG-parse one instance URL; a returned reason explains why it is unusable. */
function parseInstanceUrl(raw: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { reason: 'only http/https are supported' };
  }
  return { url };
}

/** Credential-free rendering of a URL for warning messages (secrets never logged). */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // not a URL at all — nothing credential-shaped to strip
    return raw;
  }
}

function normalizeInstanceOrigin(url: URL): string {
  url.username = '';
  url.password = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

function urlEnv(env: Env, key: string, fallback: string, warn: Warn): string {
  const raw = strEnv(env, key, fallback);
  const parsed = parseInstanceUrl(raw);
  if ('reason' in parsed) {
    if (raw !== fallback) {
      warn(`${key}: ignoring "${redactUrl(raw)}" (${parsed.reason}), using ${fallback}`);
    }
    return fallback;
  }
  return normalizeInstanceOrigin(parsed.url);
}

/** Extra failover instances (`SEARXNG_URLS`), validated like `SEARXNG_URL`:
 * invalid entries are warned about and skipped, duplicates of earlier ones dropped. */
function urlsEnv(env: Env, key: string, primary: string, warn: Warn): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return [];
  const seen = new Set([primary]);
  const urls: string[] = [];
  for (const item of raw.split(',')) {
    const candidate = item.trim();
    if (candidate === '') continue;
    const parsed = parseInstanceUrl(candidate);
    if ('reason' in parsed) {
      warn(`${key}: ignoring entry "${redactUrl(candidate)}" (${parsed.reason})`);
      continue;
    }
    const normalized = normalizeInstanceOrigin(parsed.url);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  return urls;
}

function listEnv(env: Env, key: string): string[] {
  const raw = env[key];
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function transportEnv(env: Env, warn: Warn): Transport {
  const raw = env.SEARXNG_TRANSPORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRANSPORT;
  const value = raw.trim().toLowerCase();
  if (value === 'stdio' || value === 'http') return value;
  warn(
    `SEARXNG_TRANSPORT: ignoring "${raw.trim()}" (expected "stdio" or "http"), using ${DEFAULT_TRANSPORT}`,
  );
  return DEFAULT_TRANSPORT;
}

export function loadConfig(env: Env, version: string, warn: Warn = () => {}): Config {
  const searxngUrl = urlEnv(env, 'SEARXNG_URL', DEFAULT_SEARXNG_URL, warn);
  const config: Config = {
    transport: transportEnv(env, warn),
    searxngUrl,
    searxngUrls: [searxngUrl, ...urlsEnv(env, 'SEARXNG_URLS', searxngUrl, warn)],
    searxngTimeoutMs: intEnv(
      env,
      'SEARXNG_TIMEOUT_MS',
      DEFAULT_SEARXNG_TIMEOUT_MS,
      warn,
      1,
      MAX_SEARXNG_TIMEOUT_MS,
    ),
    cacheTtlMs: intEnv(
      env,
      'SEARXNG_CACHE_TTL_MS',
      DEFAULT_CACHE_TTL_MS,
      warn,
      0,
      MAX_CACHE_TTL_MS,
    ),
    fetchTimeoutMs: intEnv(
      env,
      'FETCH_TIMEOUT_MS',
      DEFAULT_FETCH_TIMEOUT_MS,
      warn,
      1,
      MAX_FETCH_TIMEOUT_MS,
    ),
    shutdownTimeoutMs: intEnv(
      env,
      'SHUTDOWN_TIMEOUT_MS',
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      warn,
      MIN_SHUTDOWN_TIMEOUT_MS,
      MAX_SHUTDOWN_TIMEOUT_MS,
    ),
    maxChars: intEnv(env, 'MAX_CHARS', DEFAULT_MAX_CHARS, warn, 1, MAX_MAX_CHARS),
    maxResponseBytes: intEnv(
      env,
      'MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      warn,
      1,
      MAX_MAX_RESPONSE_BYTES,
    ),
    userAgent: strEnv(env, 'USER_AGENT', `searxng-mcp-server/${version}`),
    allowPrivateHosts: boolEnv(env, 'ALLOW_PRIVATE_HOSTS', false, warn),
    host: strEnv(env, 'HOST', DEFAULT_HTTP_HOST),
    port: intEnv(env, 'PORT', DEFAULT_HTTP_PORT, warn, 1, MAX_PORT, false),
    allowedHosts: listEnv(env, 'SEARXNG_ALLOWED_HOSTS'),
    allowedOrigins: listEnv(env, 'SEARXNG_ALLOWED_ORIGINS'),
    htmlFallback: boolEnv(env, 'SEARXNG_HTML_FALLBACK', false, warn),
  };
  // Optional D16 operator defaults: assigned only when configured (exactOptionalPropertyTypes).
  const defaultLanguage = strEnv(env, 'SEARXNG_DEFAULT_LANGUAGE', '').trim();
  if (defaultLanguage !== '') config.defaultLanguage = defaultLanguage;
  const defaultSafesearch = safesearchDefaultEnv(env, warn);
  if (defaultSafesearch !== undefined) config.defaultSafesearch = defaultSafesearch;
  const maxResults = optionalIntEnv(env, 'SEARXNG_MAX_RESULTS', warn, 1);
  if (maxResults !== undefined) config.maxResults = maxResults;
  if (env.SEARXNG_USERNAME) {
    config.searxngUsername = env.SEARXNG_USERNAME;
    if (!env.SEARXNG_PASSWORD) {
      warn(
        'SEARXNG_USERNAME is set without SEARXNG_PASSWORD: requests use Basic auth with an empty password',
      );
    }
  }
  if (env.SEARXNG_PASSWORD) config.searxngPassword = env.SEARXNG_PASSWORD;
  if (env.SEARXNG_AUTH_TOKEN && env.SEARXNG_AUTH_TOKEN.trim() !== '') {
    config.authToken = env.SEARXNG_AUTH_TOKEN;
  }
  assertHttpBindSafety(config.transport, config);
  return config;
}

/** Non-localhost HTTP without an auth token must refuse to start — checked
 * against the EFFECTIVE transport (env or --transport flag). */
export function assertHttpBindSafety(transport: Transport, config: Config): void {
  if (transport === 'http' && !LOCAL_HOSTS.has(config.host) && !config.authToken) {
    throw new Error(
      `HOST=${config.host} binds to a non-localhost interface; set SEARXNG_AUTH_TOKEN or bind HOST to 127.0.0.1/localhost/::1`,
    );
  }
}
