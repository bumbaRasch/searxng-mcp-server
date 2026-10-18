import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  projectEngineErrors,
  projectInstanceConfig,
  registerObservabilityResources,
} from '../src/observability.js';
import type { FetchLike } from '../src/http.js';
import { asFetchLike, jsonResponse, makeConfig } from './helpers.js';

const config = makeConfig();

interface RegisteredResource {
  uri: string;
  metadata: { title?: string; mimeType?: string; description?: string };
  read: (uri: { href: string }) => Promise<{ contents: { uri: string; text: string }[] }>;
}

function fakeServer(): { server: McpServer; resources: Map<string, RegisteredResource> } {
  const resources = new Map<string, RegisteredResource>();
  const server = {
    registerResource: (
      _name: string,
      uri: string,
      metadata: RegisteredResource['metadata'],
      read: RegisteredResource['read'],
    ) => {
      resources.set(uri, { uri, metadata, read });
    },
  } as unknown as McpServer;
  return { server, resources };
}

const CONFIG_BODY = {
  instance_name: 'my-searxng',
  version: '2026.10.13',
  limiter: true,
  safe_search: 1,
  public_instance: false,
  default_locale: 'en',
  engines: { w: { name: 'wikipedia', enabled: true, categories: ['general'] } },
};

const ERRORS_BODY = {
  arxiv: [
    {
      exception_classname: 'Timeout',
      log_message: 'request timed out',
      filename: 'searx/search/processors/online.py',
    },
    { exception_classname: 'HTTPError', log_message: 'HTTP 500' },
  ],
  wikipedia: [],
};

const observabilityFetch: FetchLike = async (url) => {
  if (url.endsWith('/config')) return jsonResponse(CONFIG_BODY);
  if (url.endsWith('/stats/errors')) return jsonResponse(ERRORS_BODY);
  throw new Error(`unexpected probe target: ${url}`);
};

describe('projectInstanceConfig', () => {
  it('projects the operator-meaningful subset defensively', () => {
    const projected = projectInstanceConfig(CONFIG_BODY);
    expect(projected).toEqual({
      instanceName: 'my-searxng',
      version: '2026.10.13',
      limiter: true,
      publicInstance: false,
      safeSearch: 1,
      defaultLocale: 'en',
      categories: ['general'],
      engines: [{ name: 'wikipedia', categories: ['general'] }],
      counts: { engines: 1, categories: 1 },
    });
    expect(projectInstanceConfig('garbage').counts).toEqual({ engines: 0, categories: 0 });
  });
});

describe('projectEngineErrors', () => {
  it('summarizes per-engine error counts with the latest class and message', () => {
    const projected = projectEngineErrors(ERRORS_BODY);
    expect(projected.totalErrors).toBe(2);
    expect(projected.engines[0]).toEqual({
      name: 'arxiv',
      errorCount: 2,
      latestClassname: 'HTTPError',
      latestMessage: 'HTTP 500',
    });
    expect(projected.engines[1]).toEqual({ name: 'wikipedia', errorCount: 0 });
  });
});

describe('registerObservabilityResources', () => {
  it('registers both resources and reads projected JSON', async () => {
    const { server, resources } = fakeServer();
    registerObservabilityResources(server, config, { fetchImpl: observabilityFetch });
    expect([...resources.keys()].toSorted()).toEqual(
      ['config://searxng', 'stats://engines/errors'].toSorted(),
    );

    const configResource = resources.get('config://searxng');
    expect(configResource?.metadata.mimeType).toBe('application/json');
    const configRead = await configResource?.read({ href: 'config://searxng' });
    const configBody = JSON.parse(configRead?.contents[0]?.text ?? '{}') as Record<string, unknown>;
    expect(configBody.limiter).toBe(true);
    expect(configBody.version).toBe('2026.10.13');

    const errorsResource = resources.get('stats://engines/errors');
    const errorsRead = await errorsResource?.read({ href: 'stats://engines/errors' });
    const errorsBody = JSON.parse(errorsRead?.contents[0]?.text ?? '{}') as {
      totalErrors: number;
    };
    expect(errorsBody.totalErrors).toBe(2);
  });

  it('surfaces probe failures as read errors (resource stays listed)', async () => {
    const { server, resources } = fakeServer();
    registerObservabilityResources(server, config, {
      fetchImpl: asFetchLike(async () => new Response('nope', { status: 500 })),
    });
    const resource = resources.get('stats://engines/errors');
    await expect(resource?.read({ href: 'stats://engines/errors' })).rejects.toThrow(/500/);
  });
});
