import { describe, expect, it } from 'vitest';
import { formatFetchedPage, formatSearchResults } from '../src/format.js';

describe('formatSearchResults', () => {
  it('renders numbered results with metadata', () => {
    const md = formatSearchResults({
      query: 'cats',
      results: [
        {
          title: 'Cats',
          url: 'https://cats.test',
          content: 'All about cats',
          engine: 'google',
          publishedDate: '2026-01-01',
        },
      ],
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsiveEngines: [],
    });
    expect(md).toContain('cats');
    expect(md).toContain('## 1. Cats');
    expect(md).toContain('https://cats.test');
    expect(md).toContain('engine: google');
    expect(md).toContain('published: 2026-01-01');
    expect(md).toContain('UNTRUSTED_WEB_CONTENT');
  });

  it('notes when there are no results', () => {
    const md = formatSearchResults({
      query: 'nothing',
      results: [],
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsiveEngines: [],
    });
    expect(md).toContain('No results.');
    expect(md).toContain('UNTRUSTED_WEB_CONTENT');
  });

  it('includes answers, suggestions and unresponsive engines', () => {
    const md = formatSearchResults({
      query: 'q',
      results: [],
      answers: [{ answer: '42', engine: 'wolfram' }],
      corrections: [],
      infoboxes: [],
      suggestions: ['other'],
      unresponsiveEngines: [['kagi', 'timeout']],
    });
    expect(md).toContain('Answers: 42');
    expect(md).toContain('Did you mean: other');
    expect(md).toContain('Unresponsive engines: kagi (timeout)');
    expect(md).toContain('UNTRUSTED_WEB_CONTENT');
  });

  it('includes corrections when present', () => {
    const md = formatSearchResults({
      query: 'nodejs',
      results: [],
      answers: [],
      corrections: ['node.js'],
      infoboxes: [],
      suggestions: [],
      unresponsiveEngines: [],
    });
    expect(md).toContain('Corrections: node.js');
    expect(md).toContain('UNTRUSTED_WEB_CONTENT');
  });
});

describe('formatFetchedPage', () => {
  it('renders title, source and body', () => {
    const md = formatFetchedPage({
      url: 'https://x.test',
      finalUrl: 'https://x.test/page',
      title: 'Page',
      content: 'Body text',
      truncated: false,
    });
    expect(md).toContain('# Page');
    expect(md).toContain('Source: https://x.test/page');
    expect(md).toContain('Body text');
  });

  it('wraps the body in untrusted content delimiters', () => {
    const md = formatFetchedPage({
      url: 'https://x.test',
      finalUrl: 'https://x.test/page',
      content: 'Body text',
      truncated: false,
    });
    expect(md).toContain('<<<UNTRUSTED_WEB_CONTENT');
    expect(md).toContain('UNTRUSTED_WEB_CONTENT>>>');
    expect(md.indexOf('<<<UNTRUSTED_WEB_CONTENT')).toBeLessThan(md.indexOf('Body text'));
    expect(md.indexOf('Body text')).toBeLessThan(md.indexOf('UNTRUSTED_WEB_CONTENT>>>'));
  });
});
