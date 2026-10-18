import { McpServer } from '@modelcontextprotocol/server';
import { TtlCache } from './cache.js';
import type { Config } from './config.js';
import { SERVER_ICONS } from './icon.js';
import { registerApps } from './apps.js';
import { registerObservabilityResources } from './observability.js';
import { registerSkills } from './skills.js';
import { registerTools, type ToolDeps } from './tools.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'searxng-mcp-server';

/** LRU capacity of the D9 response cache. */
const CACHE_MAX_ENTRIES = 128;

/** Builds a transport-agnostic MCP server; `index.ts` wires it to stdio or HTTP. */
export function createServer(config: Config, deps: ToolDeps = {}): McpServer {
  // Cache hints (Stage 7, per the 2026-07-28 caching utilities): list results
  // are static or slow-moving. resources/read keeps the conservative default
  // (ttlMs 0, private) — config:// and stats:// reflect live instance state.
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION, icons: SERVER_ICONS },
    {
      cacheHints: {
        'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
        'resources/list': { ttlMs: 60_000, cacheScope: 'public' },
        'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
      },
    },
  );
  // D9: production cache comes from config; tests may inject their own via ToolDeps.
  const cache =
    deps.cache ??
    (config.cacheTtlMs > 0
      ? new TtlCache<unknown>(CACHE_MAX_ENTRIES, config.cacheTtlMs)
      : undefined);
  registerTools(server, config, { ...deps, cache });
  registerObservabilityResources(server, config, { ...deps, cache });
  registerSkills(server);
  registerApps(server);
  return server;
}
