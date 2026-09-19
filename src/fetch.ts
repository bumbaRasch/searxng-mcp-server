import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

function tightenListMarkers(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^(\s*)[-*+][ \t]+/, '$1- ');
    })
    .join('\n');
}

const TRUNCATION_MARKER = '\n\n[Content truncated]';

export function extractArticle(
  html: string,
  _url: string,
): { title?: string; byline?: string; contentHtml?: string; textContent?: string } {
  const { document } = parseHTML(html);
  const reader = new Readability(document, { charThreshold: 0 });
  const article = reader.parse();
  if (!article) return {};
  const result: {
    title?: string;
    byline?: string;
    contentHtml?: string;
    textContent?: string;
  } = {};
  if (article.title) result.title = article.title;
  if (article.byline) result.byline = article.byline;
  if (article.content) result.contentHtml = article.content;
  if (article.textContent) result.textContent = article.textContent;
  return result;
}

export function stripToText(html: string): string {
  const { document } = parseHTML(html);
  const blocks = Array.from(
    document.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, section, article, tr, br'),
  ) as Array<{ textContent: string | null }>;
  const text =
    blocks.length > 0
      ? blocks.map((node) => node.textContent ?? '').join('\n')
      : (document.body?.textContent ?? '');
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toMarkdown(html: string): string {
  return tightenListMarkers(turndown.turndown(html)).trim();
}

export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  if (maxChars <= TRUNCATION_MARKER.length)
    return { content: text.slice(0, maxChars), truncated: true };
  const budget = maxChars - TRUNCATION_MARKER.length;
  return { content: `${text.slice(0, budget)}${TRUNCATION_MARKER}`, truncated: true };
}
