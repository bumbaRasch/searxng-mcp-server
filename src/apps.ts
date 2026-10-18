/**
 * MCP Apps (Stage 6): io.modelcontextprotocol/apps per
 * modelcontextprotocol/ext-apps. One self-contained gallery app (ui://
 * resource, text/html;profile=mcp-app) backs image_search and video_search
 * via each tool's `_meta.ui.resourceUri`. The View speaks the iframe
 * handshake with plain postMessage (the spec's no-SDK pattern) and renders
 * the tool result's structured content; hosts without Apps support never
 * load it, and those tools keep their text output unchanged — graceful
 * degradation is part of the spec.
 *
 * CSP: thumbnails come from arbitrary result hosts, so resourceDomains is
 * 'https:' (img-src); the app ships no external scripts, styles or
 * connections, and all data lands in textContent/attribute assignments —
 * never HTML parsing — so untrusted fields cannot inject markup.
 */

import type { McpServer } from '@modelcontextprotocol/server';

export const GALLERY_URI = 'ui://searxng-gallery/app.html';
export const GALLERY_MIME_TYPE = 'text/html;profile=mcp-app';

/** Tool-side `_meta.ui` linking image_search/video_search to the gallery. */
export const GALLERY_TOOL_META: Record<string, unknown> = {
  ui: { resourceUri: GALLERY_URI },
};

const GALLERY_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; padding: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.card { border: 1px solid color-mix(in oklab, currentColor 20%, transparent); border-radius: 8px;
  overflow: hidden; text-decoration: none; color: inherit; display: block; }
.card img { width: 100%; height: 140px; object-fit: cover; display: block; background: #8884; }
.meta { padding: 8px; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { opacity: 0.75; font-size: 12px; margin-top: 2px; }
.query { opacity: 0.75; margin-top: 10px; }
.empty { opacity: 0.75; }
`;

const GALLERY_HTML = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<meta charset="utf-8">',
  '<title>SearXNG media gallery</title>',
  `<style>${GALLERY_CSS}</style>`,
  '</head>',
  '<body>',
  '<div id="app"><p class="empty">Waiting for results\u2026</p></div>',
  '<script>',
  '(function () {',
  "  'use strict';",
  '  var nextId = 1;',
  '  function sendRequest(method, params) {',
  '    return new Promise(function (resolve, reject) {',
  '      var id = nextId++;',
  '      var listener = function (event) {',
  '        var data = event.data;',
  '        if (!data || data.id !== id) return;',
  "        window.removeEventListener('message', listener);",
  "        if (data.error) reject(new Error(data.error.message || 'host error'));",
  '        else resolve(data.result);',
  '      };',
  "      window.addEventListener('message', listener);",
  "      window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');",
  '    });',
  '  }',
  '  function sendNotification(method, params) {',
  "    window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params }, '*');",
  '  }',
  '  function el(tag, className, text) {',
  '    var node = document.createElement(tag);',
  '    if (className) node.className = className;',
  '    if (text !== undefined) node.textContent = String(text);',
  '    return node;',
  '  }',
  '  function safeUrl(raw) {',
  '    try {',
  '      var url = new URL(String(raw));',
  "      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();",
  '    } catch (error) { /* not a URL */ }',
  '    return null;',
  '  }',
  '  function render(result) {',
  "    var app = document.getElementById('app');",
  "    app.textContent = '';",
  '    var data = result && result.structuredContent ? result.structuredContent : {};',
  '    var results = Array.isArray(data.results) ? data.results : [];',
  '    if (results.length === 0) {',
  "      app.appendChild(el('p', 'empty', 'No results to display.'));",
  '      return;',
  '    }',
  "    var grid = el('div', 'grid');",
  '    results.forEach(function (item) {',
  "      if (!item || typeof item !== 'object') return;",
  "      var card = el('a', 'card');",
  '      var link = safeUrl(item.url);',
  "      if (link) { card.href = link; card.target = '_blank'; card.rel = 'noreferrer'; }",
  "      var src = safeUrl(item.imgSrc || item.thumbnailSrc || '');",
  '      if (src) {',
  "        var img = document.createElement('img');",
  '        img.src = src;',
  "        img.loading = 'lazy';",
  "        img.alt = item.title ? String(item.title) : 'result';",
  '        card.appendChild(img);',
  '      }',
  "      var meta = el('div', 'meta');",
  "      meta.appendChild(el('div', 'title', item.title || '(untitled)'));",
  '      var bits = [item.resolution, item.filesize, item.duration, item.author].filter(',
  "        function (value) { return value !== undefined && value !== ''; },",
  '      );',
  "      if (bits.length > 0) meta.appendChild(el('div', 'detail', bits.join(' \\u00b7 ')));",
  '      card.appendChild(meta);',
  '      grid.appendChild(card);',
  '    });',
  '    app.appendChild(grid);',
  "    app.appendChild(el('p', 'query', data.query ? 'Query: ' + data.query : ''));",
  '  }',
  "  window.addEventListener('message', function (event) {",
  '    var data = event.data;',
  "    if (!data || data.method !== 'ui/notifications/tool-result') return;",
  '    render(data.params);',
  '  });',
  "  sendRequest('ui/initialize', {",
  "    protocolVersion: '2026-01-26',",
  '    capabilities: {},',
  "    clientInfo: { name: 'searxng-gallery', version: '1.0.0' },",
  '  })',
  "    .then(function () { sendNotification('ui/notifications/initialized', {}); })",
  '    .catch(function () { /* hosts without Apps support never load this view */ });',
  '})();',
  '</script>',
  '</body>',
  '</html>',
].join('\n');

/** Registers the gallery UI resource; tools link to it via GALLERY_TOOL_META. */
export function registerApps(server: McpServer): void {
  server.registerResource(
    'searxng-gallery',
    GALLERY_URI,
    {
      title: 'SearXNG media gallery',
      description:
        "Interactive gallery rendering image_search and video_search results as a thumbnail grid. Loads only in MCP Apps-capable hosts; other clients see the tools' regular text output.",
      mimeType: GALLERY_MIME_TYPE,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: GALLERY_MIME_TYPE,
          text: GALLERY_HTML,
          _meta: { ui: { csp: { resourceDomains: ['https:'] } } },
        },
      ],
    }),
  );
}
