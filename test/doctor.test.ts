import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import type { FetchLike } from '../src/http.js';
import { asFetchLike, jsonResponse, makeConfig } from './helpers.js';

const config = makeConfig();

const HEALTHY_CONFIG = {
  engines: { w: { name: 'wikipedia', enabled: true, categories: ['general'] } },
  limiter: true,
  version: '2026.10.13',
};

const HEALTHY_SEARCH = {
  query: 'searxng',
  results: [{ title: 'T', url: 'https://r.test/x', content: 'c' }],
  unresponsive_engines: [],
};

function instanceFetch(
  searchStatus = 200,
  searchBody: unknown = HEALTHY_SEARCH,
  configBody: unknown = HEALTHY_CONFIG,
): FetchLike {
  return async (url) => {
    if (url.includes('/search?')) {
      if (searchStatus !== 200) return new Response('blocked', { status: searchStatus });
      return jsonResponse(searchBody);
    }
    return jsonResponse(configBody);
  };
}

describe('runDoctor', () => {
  it('reports all-ok checks on a healthy instance', async () => {
    const report = await runDoctor(config, { fetchImpl: instanceFetch() });
    expect(report.healthy).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'config_endpoint',
      'json_api',
      'unresponsive_engines',
      'limiter',
    ]);
    const limiter = report.checks.find((check) => check.id === 'limiter');
    expect(limiter?.detail).toContain('enabled');
    const configCheck = report.checks.find((check) => check.id === 'config_endpoint');
    expect(configCheck?.detail).toContain('1 engines');
  });

  it('diagnoses a JSON-disabled instance (403) with the settings hint', async () => {
    const report = await runDoctor(config, { fetchImpl: instanceFetch(403) });
    expect(report.healthy).toBe(false);
    const jsonApi = report.checks.find((check) => check.id === 'json_api');
    expect(jsonApi?.ok).toBe(false);
    expect(jsonApi?.detail).toMatch(/403/);
    expect(jsonApi?.detail).toMatch(/search\.formats/);
  });

  it('flags the limiter on a 429 probe', async () => {
    const report = await runDoctor(config, { fetchImpl: instanceFetch(429) });
    expect(report.healthy).toBe(false);
    expect(report.checks.find((check) => check.id === 'limiter')?.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'json_api')?.ok).toBe(false);
  });

  it('reports limiter state from /config when the search probe fails with another error', async () => {
    const report = await runDoctor(config, { fetchImpl: instanceFetch(500) });
    expect(report.healthy).toBe(false);
    const limiters = report.checks.filter((check) => check.id === 'limiter');
    expect(limiters).toHaveLength(1);
    expect(limiters[0]?.ok).toBe(true);
    expect(limiters[0]?.detail).toContain('enabled');
  });

  it('reports unreachable instances without throwing', async () => {
    const report = await runDoctor(config, {
      fetchImpl: asFetchLike(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((check) => !check.ok)).toBe(true);
  });

  it('lists unresponsive engines from the probe search', async () => {
    const report = await runDoctor(config, {
      fetchImpl: instanceFetch(200, {
        ...HEALTHY_SEARCH,
        unresponsive_engines: [
          ['arxiv', 'timeout'],
          ['openalex', 'HTTP 500'],
        ],
      }),
    });
    const check = report.checks.find((entry) => entry.id === 'unresponsive_engines');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('arxiv');
    expect(check?.detail).toContain('openalex');
  });
});
