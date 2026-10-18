/**
 * Observability resources: read-only views of the primary instance's live
 * state, per the 2026-07-28 Resources surface (custom URI schemes are
 * spec-legal, RFC3986). config:// mirrors /config (defensively projected);
 * stats:// mirrors /stats/errors — the per-engine error records, because the
 * /stats page itself is HTML-only (verified against searx/webapp.py).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { isRecord, sanitizeUntrusted } from './categories/shared.js';
import type { Config } from './config.js';
import { mapEnginesResponse, probeInstanceJson, type ClientOptions } from './searxng.js';
import type { ToolDeps } from './tools.js';

const CONFIG_URI = 'config://searxng';
const ENGINE_ERRORS_URI = 'stats://engines/errors';
/** Cap on engine summaries in one stats response (matches MAX_ENGINES elsewhere). */
const MAX_ENGINE_SUMMARIES = 100;

function toClientOptions(deps: ToolDeps): ClientOptions {
  return { fetchImpl: deps.fetchImpl, cache: deps.cache };
}

/** Defensive projection of /config: the operator-meaningful subset. */
export function projectInstanceConfig(raw: unknown): Record<string, unknown> {
  const data = isRecord(raw) ? raw : {};
  const engines = mapEnginesResponse(raw);
  const projected: Record<string, unknown> = {
    limiter: data.limiter === true,
    publicInstance: data.public_instance === true,
    categories: engines.categories,
    engines: engines.engines,
    counts: engines.counts,
  };
  if (typeof data.instance_name === 'string') projected.instanceName = data.instance_name;
  if (typeof data.version === 'string') projected.version = data.version;
  if (typeof data.default_locale === 'string') projected.defaultLocale = data.default_locale;
  if (typeof data.safe_search === 'number') projected.safeSearch = data.safe_search;
  return projected;
}

export interface EngineErrorSummary {
  name: string;
  errorCount: number;
  latestClassname?: string;
  latestMessage?: string;
}

/** Defensive projection of /stats/errors: per-engine error counts + the most
 * recent error's class and message. */
export function projectEngineErrors(raw: unknown): {
  totalErrors: number;
  engines: EngineErrorSummary[];
} {
  const data = isRecord(raw) ? raw : {};
  const engines: EngineErrorSummary[] = [];
  let totalErrors = 0;
  for (const [name, value] of Object.entries(data)) {
    const errors = Array.isArray(value) ? value.filter(isRecord) : [];
    totalErrors += errors.length;
    const latest = errors.at(-1);
    const summary: EngineErrorSummary = { name, errorCount: errors.length };
    if (typeof latest?.exception_classname === 'string') {
      summary.latestClassname = latest.exception_classname;
    }
    if (typeof latest?.log_message === 'string') summary.latestMessage = latest.log_message;
    engines.push(summary);
  }
  return {
    totalErrors,
    engines: engines
      .toSorted((a, b) => b.errorCount - a.errorCount || a.name.localeCompare(b.name))
      .slice(0, MAX_ENGINE_SUMMARIES),
  };
}

export function registerObservabilityResources(
  server: McpServer,
  config: Config,
  deps: ToolDeps = {},
): void {
  server.registerResource(
    'instance-config',
    CONFIG_URI,
    {
      title: 'SearXNG instance configuration',
      description:
        'Live /config projection of the primary SearXNG instance: instance name and version, limiter state, enabled engines and categories.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const raw = await probeInstanceJson(config, '/config', toClientOptions(deps));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: sanitizeUntrusted(JSON.stringify(projectInstanceConfig(raw))),
          },
        ],
      };
    },
  );

  server.registerResource(
    'engine-errors',
    ENGINE_ERRORS_URI,
    {
      title: 'SearXNG engine errors',
      description:
        'Live /stats/errors projection of the primary SearXNG instance: per-engine error counts and the most recent error class and message.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const raw = await probeInstanceJson(config, '/stats/errors', toClientOptions(deps));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: sanitizeUntrusted(JSON.stringify(projectEngineErrors(raw))),
          },
        ],
      };
    },
  );
}
