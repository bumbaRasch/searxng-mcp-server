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

const DEFAULT_SEARXNG_URL = 'http://localhost:8888';

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

function urlEnv(env: Env, key: string, fallback: string): string {
  const raw = strEnv(env, key, fallback);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    url.username = '';
    url.password = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path === '/' ? '' : path}` || fallback;
  } catch {
    return fallback;
  }
}

export function loadConfig(env: Env, version = '0.0.0'): Config {
  const config: Config = {
    searxngUrl: urlEnv(env, 'SEARXNG_URL', DEFAULT_SEARXNG_URL),
    searxngTimeoutMs: intEnv(env, 'SEARXNG_TIMEOUT_MS', 10_000),
    fetchTimeoutMs: intEnv(env, 'FETCH_TIMEOUT_MS', 15_000),
    maxChars: intEnv(env, 'MAX_CHARS', 25_000),
    maxResponseBytes: intEnv(env, 'MAX_RESPONSE_BYTES', 5_242_880),
    userAgent: strEnv(env, 'USER_AGENT', `searxng-mcp-ts/${version}`),
    allowPrivateHosts: boolEnv(env, 'ALLOW_PRIVATE_HOSTS', false),
  };
  if (env.SEARXNG_USERNAME) config.searxngUsername = env.SEARXNG_USERNAME;
  if (env.SEARXNG_PASSWORD) config.searxngPassword = env.SEARXNG_PASSWORD;
  return config;
}
