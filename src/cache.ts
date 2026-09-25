/**
 * Opt-in in-memory TTL + LRU cache for instance-bound GET responses (D9).
 * Disabled by default (`SEARXNG_CACHE_TTL_MS=0`); `fetch_content` never uses it.
 */

/** Map iteration order is insertion order, so the delete+set pairs below are the LRU recency update. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  /** Returns the value, or undefined when missing, expired, or disabled. */
  get(key: string): V | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/** Canonical cache key (D9): uppercased method plus a URL with a normalized
 * host (WHATWG: lowercased, default ports dropped) and sorted query params. */
export function cacheKey(method: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  const params = [...parsed.searchParams.entries()].toSorted(
    (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
  );
  const canonical = new URLSearchParams();
  for (const [name, value] of params) canonical.append(name, value);
  const query = canonical.toString();
  return `${method.toUpperCase()} ${parsed.protocol}//${parsed.host}${parsed.pathname}${query === '' ? '' : `?${query}`}`;
}

/** Call-site wrapper: serve `load()` from the cache; an undefined or disabled
 * cache passes straight through, keeping the default-off path untouched. */
export async function cached<V>(
  cache: TtlCache<V> | undefined,
  method: string,
  url: string,
  load: () => Promise<V>,
): Promise<V> {
  if (!cache?.enabled) return load();
  const key = cacheKey(method, url);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await load();
  cache.set(key, value);
  return value;
}
