/**
 * Session-scoped citation refs: stable numbered source IDs that let MCP
 * clients address a search result as `ref:N` instead of repeating the URL.
 * One instance lives per process (`sharedRefs`) — HTTP serving is stateless
 * per request, so the ref session must outlive individual requests. Numbers
 * are monotonic and never reused: an evicted ref resolves to undefined
 * rather than silently to a different URL.
 */

const MAX_REFS = 512;

export class RefRegistry {
  private readonly refByUrl = new Map<string, number>();
  private readonly urlByRef = new Map<number, string>();
  private next = 1;

  constructor(private readonly maxEntries: number = MAX_REFS) {}

  /** The ref for `url`, minting the next number on first sight. */
  assign(url: string): number {
    const existing = this.refByUrl.get(url);
    if (existing !== undefined) return existing;
    if (this.urlByRef.size >= this.maxEntries) {
      // Map iteration order is insertion order, so the first key is the
      // oldest minted ref; evict it from both directions.
      const oldest = this.urlByRef.keys().next();
      if (!oldest.done) {
        const evictedUrl = this.urlByRef.get(oldest.value);
        this.urlByRef.delete(oldest.value);
        if (evictedUrl !== undefined) this.refByUrl.delete(evictedUrl);
      }
    }
    const ref = this.next++;
    this.refByUrl.set(url, ref);
    this.urlByRef.set(ref, url);
    return ref;
  }

  resolve(ref: number): string | undefined {
    return this.urlByRef.get(ref);
  }
}

/** Production ref session; tests inject their own via ToolDeps.refs. */
export const sharedRefs = new RefRegistry();
