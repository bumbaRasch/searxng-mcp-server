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

interface WalkNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<WalkNode>;
  tagName?: string;
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
  'TR',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'PRE',
  'UL',
  'OL',
  'TABLE',
  'BR',
]);

function collectText(node: WalkNode, out: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out.push(child.textContent ?? '');
    } else if (child.nodeType === 1) {
      const isBlock = BLOCK_TAGS.has((child.tagName ?? '').toUpperCase());
      if (isBlock) out.push('\n');
      collectText(child, out);
      if (isBlock) out.push('\n');
    }
  }
}

const TRUNCATION_MARKER = '\n\n[Content truncated]';

export function extractArticle(
  html: string,
  _url: string,
): { title?: string; byline?: string; contentHtml?: string; textContent?: string } {
  if (html.trim() === '') return {};
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
  if (html.trim() === '') return '';
  const { document } = parseHTML(html);
  const body = document.body;
  const root = body && body.childNodes.length > 0 ? body : (document.documentElement ?? body);
  const out: string[] = [];
  if (root) collectText(root, out);
  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toMarkdown(html: string): string {
  return tightenListMarkers(turndown.turndown(html)).trim();
}

export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { content: text, truncated: false };
  const budget = Math.max(0, limit - TRUNCATION_MARKER.length);
  const suffix = TRUNCATION_MARKER.length <= limit ? TRUNCATION_MARKER : '';
  return { content: `${text.slice(0, budget)}${suffix}`, truncated: true };
}
