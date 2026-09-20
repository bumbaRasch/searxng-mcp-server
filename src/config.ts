export interface Config {
  searxngUrl: string;
  searxngUsername?: string;
  searxngPassword?: string;
  searxngTimeoutMs: number;
  fetchTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxChars: number;
  maxResponseBytes: number;
  userAgent: string;
  allowPrivateHosts: boolean;
}

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const DEFAULT_SEARXNG_URL = 'http://localhost:8888';
const DEFAULT_SEARXNG_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 25_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 100;

function intEnv(env: Env, key: string, fallback: number, warn: Warn, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min) return Math.floor(value);
  warn(`${key}: ignoring "${raw.trim()}" (expected an integer >= ${min}), using ${fallback}`);
  return fallback;
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

function strEnv(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function urlEnv(env: Env, key: string, fallback: string, warn: Warn): string {
  const raw = strEnv(env, key, fallback);
  const fail = (reason: string): string => {
    if (raw !== fallback) {
      let safe = raw;
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        safe = url.toString();
      } catch {
        // not a URL at all — nothing credential-shaped to strip
      }
      warn(`${key}: ignoring "${safe}" (${reason}), using ${fallback}`);
    }
    return fallback;
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('only http/https are supported');
  }
  url.username = '';
  url.password = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function loadConfig(env: Env, version: string, warn: Warn = () => {}): Config {
  const config: Config = {
    searxngUrl: urlEnv(env, 'SEARXNG_URL', DEFAULT_SEARXNG_URL, warn),
    searxngTimeoutMs: intEnv(env, 'SEARXNG_TIMEOUT_MS', DEFAULT_SEARXNG_TIMEOUT_MS, warn),
    fetchTimeoutMs: intEnv(env, 'FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS, warn),
    shutdownTimeoutMs: intEnv(
      env,
      'SHUTDOWN_TIMEOUT_MS',
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      warn,
      MIN_SHUTDOWN_TIMEOUT_MS,
    ),
    maxChars: intEnv(env, 'MAX_CHARS', DEFAULT_MAX_CHARS, warn),
    maxResponseBytes: intEnv(env, 'MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES, warn),
    userAgent: strEnv(env, 'USER_AGENT', `searxng-mcp-server/${version}`),
    allowPrivateHosts: boolEnv(env, 'ALLOW_PRIVATE_HOSTS', false, warn),
  };
  if (env.SEARXNG_USERNAME) config.searxngUsername = env.SEARXNG_USERNAME;
  if (env.SEARXNG_PASSWORD) config.searxngPassword = env.SEARXNG_PASSWORD;
  return config;
}
