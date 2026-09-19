export interface Config {
  searxngUrl: string;
  searxngUsername?: string;
  searxngPassword?: string;
  searxngTimeoutMs: number;
  fetchTimeoutMs: number;
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

function intEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function boolEnv(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function strEnv(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function urlEnv(env: Env, key: string, fallback: string, warn: Warn): string {
  const raw = strEnv(env, key, fallback);
  const fail = (reason: string): string => {
    if (raw !== fallback) warn(`${key}: ignoring "${raw}" (${reason}), using ${fallback}`);
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
    searxngTimeoutMs: intEnv(env, 'SEARXNG_TIMEOUT_MS', DEFAULT_SEARXNG_TIMEOUT_MS),
    fetchTimeoutMs: intEnv(env, 'FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS),
    maxChars: intEnv(env, 'MAX_CHARS', DEFAULT_MAX_CHARS),
    maxResponseBytes: intEnv(env, 'MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES),
    userAgent: strEnv(env, 'USER_AGENT', `searxng-mcp-ts/${version}`),
    allowPrivateHosts: boolEnv(env, 'ALLOW_PRIVATE_HOSTS', false),
  };
  if (env.SEARXNG_USERNAME) config.searxngUsername = env.SEARXNG_USERNAME;
  if (env.SEARXNG_PASSWORD) config.searxngPassword = env.SEARXNG_PASSWORD;
  return config;
}
