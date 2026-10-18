import { describe, expect, it } from 'vitest';
import { queryTerms, rerankResults, rerankScore } from '../src/rerank.js';

const NOW = Date.parse('2026-10-18T00:00:00Z');

function makeResult(overrides: Record<string, unknown>): {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
} {
  return {
    title: 'generic',
    url: 'https://plain.test/a',
    content: 'nothing relevant here',
    ...overrides,
  };
}

describe('queryTerms', () => {
  it('tokenizes, lowercases, drops short terms and dedupes', () => {
    expect(queryTerms('Rust async: an async runtime! a')).toEqual([
      'rust',
      'async',
      'an',
      'runtime',
    ]);
  });
});

describe('rerankScore', () => {
  it('scores title overlap above content overlap', () => {
    const terms = queryTerms('rust async');
    const titleHit = rerankScore(
      makeResult({ title: 'rust async guide', content: 'unrelated' }),
      terms,
      NOW,
      [],
    );
    const contentHit = rerankScore(
      makeResult({ title: 'unrelated', content: 'rust async guide' }),
      terms,
      NOW,
      [],
    );
    expect(titleHit).toBeGreaterThan(contentHit);
  });

  it('boosts freshness linearly and ignores unparseable dates', () => {
    const terms = queryTerms('unrelated query');
    const fresh = rerankScore(makeResult({ publishedDate: '2026-10-01' }), terms, NOW, []);
    const stale = rerankScore(makeResult({ publishedDate: '2019-10-01' }), terms, NOW, []);
    const undated = rerankScore(makeResult({}), terms, NOW, []);
    const garbage = rerankScore(makeResult({ publishedDate: 'not-a-date' }), terms, NOW, []);
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThanOrEqual(undated);
    expect(garbage).toBe(undated);
  });

  it('boosts configured domains by suffix match only', () => {
    const terms = queryTerms('unrelated query');
    const boosted = rerankScore(makeResult({ url: 'https://sub.trusted.test/x' }), terms, NOW, [
      'trusted.test',
    ]);
    const exact = rerankScore(makeResult({ url: 'https://trusted.test/x' }), terms, NOW, [
      'trusted.test',
    ]);
    const other = rerankScore(makeResult({ url: 'https://other.test/x' }), terms, NOW, [
      'trusted.test',
    ]);
    const lookalike = rerankScore(makeResult({ url: 'https://nottrusted.test/x' }), terms, NOW, [
      'trusted.test',
    ]);
    expect(boosted).toBe(exact);
    expect(exact).toBeGreaterThan(other);
    expect(other).toBe(lookalike);
  });
});

describe('rerankResults', () => {
  it('moves the overlap-matching result to the top', () => {
    const results = [
      makeResult({ title: 'first upstream', content: '' }),
      makeResult({ title: 'rust async runtime deep dive', content: '' }),
    ];
    const reranked = rerankResults('rust async runtime', results);
    expect(reranked[0]?.title).toContain('rust async');
  });

  it('prefers the fresher of two equal-overlap results', () => {
    const results = [
      makeResult({ title: 'rust async', publishedDate: '2019-01-01' }),
      makeResult({ title: 'rust async guide', publishedDate: '2026-10-01' }),
    ];
    const reranked = rerankResults('rust async', results, { now: () => NOW });
    expect(reranked[0]?.publishedDate).toBe('2026-10-01');
  });

  it('keeps the upstream order on ties', () => {
    const results = [
      makeResult({ title: 'aaa', url: 'https://x.test/1' }),
      makeResult({ title: 'bbb', url: 'https://x.test/2' }),
    ];
    expect(rerankResults('zzz', results)).toEqual(results);
  });

  it('applies the domain boost', () => {
    const results = [
      makeResult({ title: 'rust async here', url: 'https://plain.test/x' }),
      makeResult({ title: 'rust async there', url: 'https://trusted.test/x' }),
    ];
    const reranked = rerankResults('rust async', results, { boostDomains: ['trusted.test'] });
    expect(reranked[0]?.url).toBe('https://trusted.test/x');
  });
});
