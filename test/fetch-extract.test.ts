import { describe, expect, it } from 'vitest';
import { cleanContentHtml, extractArticle, stripToText } from '../src/extract.js';
import { toMarkdown, truncate } from '../src/markdown.js';

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

describe('cleanContentHtml', () => {
  it('absolutizes relative links and image sources against the base URL', () => {
    const html =
      '<div><a href="/posts/1">post</a> <a href="page2.html">next</a> <img src="/img/x.png"></div>';
    const cleaned = cleanContentHtml(html, 'https://blog.test/archives/');
    expect(cleaned).toContain('href="https://blog.test/posts/1"');
    expect(cleaned).toContain('href="https://blog.test/archives/page2.html"');
    expect(cleaned).toContain('src="https://blog.test/img/x.png"');
  });

  it('keeps already-absolute http(s) URLs and harmless schemes', () => {
    const html = '<a href="https://abs.test/x">a</a><a href="mailto:hi@example.test">m</a>';
    const cleaned = cleanContentHtml(html, 'https://base.test/');
    expect(cleaned).toContain('href="https://abs.test/x"');
    expect(cleaned).toContain('mailto:hi@example.test');
  });

  it('removes dangerous href schemes', () => {
    const cleaned = cleanContentHtml(
      '<a href="javascript:alert(1)">x</a><a href="data:text/html,evil">y</a>',
      'https://base.test/',
    );
    expect(cleaned).not.toContain('javascript:');
    expect(cleaned).not.toContain('data:text/html');
  });

  it('drops script, style, noscript and template elements', () => {
    const html =
      '<p>keep</p><script>alert(1)</script><style>p{}</style><noscript>no</noscript><template>t</template>';
    expect(cleanContentHtml(html, 'https://base.test/')).toBe('<p>keep</p>');
  });

  it('flows through extractArticle into markdown', () => {
    const html = `<!doctype html><html><head><title>Linked</title></head><body>
      <article><h1>Linked</h1>
        <p>Enough words to make readability extract this article properly, with a
        <a href="/rel">relative link</a> and an image <img src="pic.png"> inside.</p>
      </article></body></html>`;
    const article = extractArticle(html, 'https://blog.test/posts/1');
    expect(article.contentHtml).toContain('https://blog.test/rel');
    expect(article.contentHtml).toContain('https://blog.test/posts/pic.png');
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

  it('skips script, style, noscript and template text', () => {
    const text = stripToText(
      '<html><body><p>Alpha</p><script>alert(1)</script><style>p{color:red}</style><noscript>nope</noscript><template>tpl</template></body></html>',
    );
    expect(text).toContain('Alpha');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('nope');
    expect(text).not.toContain('tpl');
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
