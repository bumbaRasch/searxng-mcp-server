import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { GALLERY_MIME_TYPE, GALLERY_TOOL_META, GALLERY_URI, registerApps } from '../src/apps.js';
import { TOOL_NAMES, registerTools } from '../src/tools.js';
import { makeConfig } from './helpers.js';

const config = makeConfig();

interface CapturedContent {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: unknown;
}

interface CapturedAppResource {
  uri: string;
  metadata: { mimeType?: string };
  read: (uri: { href: string }) => { contents: CapturedContent[] };
}

describe('registerApps', () => {
  it('serves the gallery as an mcp-app HTML resource with a CSP', () => {
    let resource: CapturedAppResource | undefined;
    const server = {
      registerResource: (
        _name: string,
        uri: string,
        metadata: { mimeType?: string },
        read: CapturedAppResource['read'],
      ) => {
        resource = { uri, metadata, read };
      },
    } as unknown as McpServer;
    registerApps(server);
    expect(resource?.uri).toBe(GALLERY_URI);
    expect(resource?.metadata.mimeType).toBe('text/html;profile=mcp-app');
    const content = resource?.read({ href: GALLERY_URI }).contents[0];
    expect(content?.mimeType).toBe(GALLERY_MIME_TYPE);
    expect(content?._meta).toEqual({ ui: { csp: { resourceDomains: ['https:'] } } });
  });

  it('speaks the iframe handshake and renders only via safe DOM APIs', () => {
    let html = '';
    const server = {
      registerResource: (
        _name: string,
        _uri: string,
        _metadata: unknown,
        read: (uri: { href: string }) => { contents: { text: string }[] },
      ) => {
        html = read({ href: GALLERY_URI }).contents[0]?.text ?? '';
      },
    } as unknown as McpServer;
    registerApps(server);
    // Handshake per the ext-apps no-SDK pattern.
    expect(html).toContain('ui/initialize');
    expect(html).toContain('appCapabilities');
    expect(html).not.toContain('capabilities:');
    expect(html).toContain('ui/notifications/initialized');
    expect(html).toContain('ui/notifications/tool-result');
    expect(html).toContain('2026-01-26');
    // Untrusted data must never be parsed as HTML: textContent/createElement only.
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('document.write');
    expect(html).toContain('textContent');
    // Links and media sources are protocol-checked before assignment.
    expect(html).toContain('safeUrl');
    expect(html).toContain("'http:' || url.protocol === 'https:'");
  });
});

describe('gallery tool wiring', () => {
  it('links image_search and video_search to the gallery; other tools are plain', () => {
    const registered = new Map<string, { _meta?: Record<string, unknown> }>();
    const server = {
      registerTool: (name: string, toolConfig: { _meta?: Record<string, unknown> }) => {
        registered.set(name, toolConfig);
      },
      server: { setRequestHandler: () => {} },
    } as unknown as McpServer;
    registerTools(server, config);
    for (const name of TOOL_NAMES) {
      const tool = registered.get(name);
      const meta = tool?._meta;
      if (name === 'image_search' || name === 'video_search') {
        expect(meta).toEqual(GALLERY_TOOL_META);
        const ui = meta?.ui as { resourceUri?: string } | undefined;
        expect(ui?.resourceUri).toBe(GALLERY_URI);
      } else {
        expect(tool?._meta).toBeUndefined();
      }
    }
  });
});
