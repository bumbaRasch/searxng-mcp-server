/**
 * Heuristic rerank: reorder delivered results by query/title overlap,
 * freshness and configured domain boosts, layered on top of SearXNG's own
 * ranking and the min_score floor. Pure and deterministic — ties keep the
 * upstream order.
 */

export interface RerankOptions {
  /** Hostnames (suffix match) that get a flat boost; SEARXNG_RERANK_BOOST_DOMAINS. */
  boostDomains?: string[] | undefined;
  /** Injectable clock for freshness decay (tests). */
  now?: () => number;
}

export interface RerankableResult {
  title: string;
  url: string;
  content?: string | undefined;
  publishedDate?: string | undefined;
}

const TERM_PATTERN = /[\p{L}\p{N}]+/gu;
/** Weight of a fully-overlapping query vs. the rest of the score. */
const OVERLAP_WEIGHT = 0.65;
const FRESHNESS_WEIGHT = 0.25;
const DOMAIN_BOOST = 0.25;
/** One year, in days: freshness decays linearly to zero across it. */
const FRESHNESS_HORIZON_DAYS = 365;

export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(TERM_PATTERN) ?? [];
  return [...new Set(terms.filter((term) => term.length >= 2))];
}

function overlapRatio(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Linear decay over one year; an unparseable date earns nothing. */
function freshness(publishedDate: string | undefined, now: number): number {
  if (publishedDate === undefined) return 0;
  let stamp = Date.parse(publishedDate);
  if (Number.isNaN(stamp)) stamp = Date.parse(publishedDate.slice(0, 10));
  if (Number.isNaN(stamp)) return 0;
  const ageDays = Math.max(0, (now - stamp) / 86_400_000);
  return Math.max(0, 1 - ageDays / FRESHNESS_HORIZON_DAYS);
}

function domainBoostOf(hostname: string, boostDomains: string[]): number {
  const boosted = boostDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
  return boosted ? DOMAIN_BOOST : 0;
}

export function rerankScore(
  result: RerankableResult,
  terms: string[],
  now: number,
  boostDomains: string[],
): number {
  const overlap =
    0.7 * overlapRatio(terms, result.title) + 0.3 * overlapRatio(terms, result.content ?? '');
  return (
    OVERLAP_WEIGHT * overlap +
    FRESHNESS_WEIGHT * freshness(result.publishedDate, now) +
    domainBoostOf(hostOf(result.url), boostDomains)
  );
}

export function rerankResults<R extends RerankableResult>(
  query: string,
  results: R[],
  opts: RerankOptions = {},
): R[] {
  const terms = queryTerms(query);
  const now = opts.now?.() ?? Date.now();
  const boostDomains = opts.boostDomains ?? [];
  return results
    .map((result, index) => ({
      result,
      index,
      score: rerankScore(result, terms, now, boostDomains),
    }))
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.result);
}
