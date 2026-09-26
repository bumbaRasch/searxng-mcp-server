import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_HTML_RESULTS, parseSearchResultsHtml } from '../src/html-results.js';
import { mapSearchResponse } from '../src/searxng.js';
import { searchOutput } from '../src/schemas.js';

const FIXTURE = readFileSync(
  new URL('./fixtures/searxng-result-page.html', import.meta.url),
  'utf8',
);

describe('parseSearchResultsHtml (D13/V7)', () => {
  it('parses the fixture result table and drops malformed items', () => {
    const payload = parseSearchResultsHtml(FIXTURE, 'test query');
    expect(payload.query).toBe('test query');
    expect(payload.results.map((result) => result.title)).toEqual([
      'First & foremost result',
      'Second result',
      'Third result',
      'Multiline snippet',
    ]);
  });

  it('extracts url from h3 > a[href] and never from the visible link text', () => {
    const [first] = parseSearchResultsHtml(FIXTURE, 'q').results;
    expect(first?.url).toBe('https://docs.test/first');
  });

  it('decodes entities in title, collapses snippet whitespace and markup', () => {
    const [first, , , multiline] = parseSearchResultsHtml(FIXTURE, 'q').results;
    expect(first?.content).toBe('Snippet with markup and entities: café — résumé');
    expect(multiline?.content).toBe('Line one. Line two.');
  });

  it('reads engines from div.engines > span and the date from time[datetime] only when present', () => {
    const results = parseSearchResultsHtml(FIXTURE, 'q').results;
    expect(results[0]?.engines).toEqual(['google', 'bing']);
    expect(results[0]?.publishedDate).toBe('2026-09-20T12:00:00Z');
    expect(results[1]).not.toHaveProperty('engines');
    expect(results[1]).not.toHaveProperty('publishedDate');
    expect(results[2]?.engines).toEqual(['duckduckgo']);
    // time.published_date without a datetime attribute carries no machine date
    expect(results[2]).not.toHaveProperty('publishedDate');
    expect(results[3]?.content).toBe('Line one. Line two.');
  });

  it('tolerates empty and garbage pages', () => {
    expect(parseSearchResultsHtml('', 'q')).toEqual({ query: 'q', results: [] });
    expect(parseSearchResultsHtml('<html><body>not a result page</body></html>', 'q')).toEqual({
      query: 'q',
      results: [],
    });
  });

  it('caps parsed results at MAX_HTML_RESULTS', () => {
    const many = Array.from(
      { length: MAX_HTML_RESULTS + 10 },
      (_, i) =>
        `<article class="result"><h3><a href="https://c.test/${i}">T${i}</a></h3>` +
        '<p class="content">c</p></article>',
    ).join('');
    const payload = parseSearchResultsHtml(`<div id="results">${many}</div>`, 'q');
    expect(payload.results).toHaveLength(MAX_HTML_RESULTS);
    expect(payload.results.at(-1)?.url).toBe(`https://c.test/${MAX_HTML_RESULTS - 1}`);
  });

  it('feeds the shared web projector and matches the search output schema', () => {
    const envelope = mapSearchResponse(parseSearchResultsHtml(FIXTURE, 'test query'), 10);
    expect(envelope.suggestions).toEqual([]);
    expect(envelope.unresponsiveEngines).toEqual([]);
    expect(envelope.results).toHaveLength(4);
    expect(envelope.results[0]).toEqual({
      title: 'First & foremost result',
      url: 'https://docs.test/first',
      content: 'Snippet with markup and entities: café — résumé',
      engines: ['google', 'bing'],
      publishedDate: '2026-09-20T12:00:00Z',
    });
    expect(searchOutput.safeParse(envelope).success).toBe(true);
  });
});
