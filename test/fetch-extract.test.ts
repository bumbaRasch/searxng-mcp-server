import { describe, expect, it } from 'vitest';
import { extractArticle, stripToText, toMarkdown, truncate } from '../src/fetch.js';

const ARTICLE_HTML = `<!doctype html><html><head><title>My Post</title></head><body>
  <article>
    <h1>My Post</h1>
    <p>First paragraph with a <a href="https://example.com">link</a>.</p>
    <p>Second paragraph with enough words to satisfy readability thresholds and make the
    extraction produce a usable article body for the reader. More words here to be safe.</p>
    <ul><li>one</li><li>two</li></ul>
  </article>
</body></html>`;

describe('extractArticle', () => {
  it('extracts a title and content', () => {
    const article = extractArticle(ARTICLE_HTML, 'https://blog.test/post');
    expect(article.title).toContain('My Post');
    expect(article.contentHtml ?? '').toContain('<p>');
  });

  it('returns an empty object for empty HTML', () => {
    expect(extractArticle('<html><body></body></html>', 'https://blog.test/x')).toEqual({});
  });

  it('returns an empty object for an empty string', () => {
    expect(extractArticle('', 'https://x.test')).toEqual({});
  });
});

describe('toMarkdown', () => {
  it('converts headings, paragraphs and lists', () => {
    const md = toMarkdown(
      '<h2>Hi</h2><p>Hello <a href="https://x.test">x</a></p><ul><li>a</li></ul>',
    );
    expect(md).toContain('## Hi');
    expect(md).toContain('[x](https://x.test)');
    expect(md).toContain('- a');
  });

  it('leaves fenced code blocks untouched', () => {
    const md = toMarkdown('<pre><code>-   keep</code></pre>');
    expect(md).toContain('-   keep');
  });
});

describe('stripToText', () => {
  const FLAT = '<html><body><p>Alpha</p><p>Beta</p></body></html>';

  it('returns readable text without tags and separates flat siblings', () => {
    const text = stripToText(FLAT);
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('AlphaBeta');
  });

  it('does not duplicate or concatenate nested blocks', () => {
    const text = stripToText('<div><p>Alpha</p><p>Beta</p></div>');
    expect(text).not.toContain('AlphaBeta');
    expect(text.split('Alpha').length - 1).toBe(1);
    expect(text.split('Beta').length - 1).toBe(1);
  });

  it('returns an empty string for empty input', () => {
    expect(stripToText('')).toBe('');
  });
});

describe('truncate', () => {
  it('returns text unchanged when under the limit', () => {
    expect(truncate('abc', 10)).toEqual({ content: 'abc', truncated: false });
  });

  it('cuts and marks when over the limit', () => {
    const result = truncate(`abcdef${'x'.repeat(50)}`, 30);
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith('abcdef')).toBe(true);
    expect(result.content).toContain('[Content truncated]');
    expect(result.content.length).toBeLessThanOrEqual(30);
  });

  it('never exceeds maxChars even when maxChars is smaller than the marker', () => {
    const result = truncate('abcdefghij', 5);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(5);
  });

  it('never exceeds a zero cap', () => {
    const result = truncate('abcdefghij', 0);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(0);
  });

  it('clamps a negative cap to zero', () => {
    expect(truncate('abcdefghij', -5)).toEqual({ content: '', truncated: true });
  });

  it('never exceeds maxChars for a large string', () => {
    const result = truncate('x'.repeat(1000), 100);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(100);
  });
});
