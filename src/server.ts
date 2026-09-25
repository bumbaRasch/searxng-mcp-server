import { McpServer } from '@modelcontextprotocol/server';
import { TtlCache } from './cache.js';
import type { Config } from './config.js';
import { SERVER_ICONS } from './icon.js';
import { registerTools, type ToolDeps } from './tools.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'searxng-mcp-server';

/** LRU capacity of the D9 response cache. */
const CACHE_MAX_ENTRIES = 128;

/** Builds a transport-agnostic MCP server; `index.ts` wires it to stdio or HTTP. */
export function createServer(config: Config, deps: ToolDeps = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
    icons: SERVER_ICONS,
  });
  // D9: production cache comes from config; tests may inject their own via ToolDeps.
  const cache =
    deps.cache ??
    (config.cacheTtlMs > 0
      ? new TtlCache<unknown>(CACHE_MAX_ENTRIES, config.cacheTtlMs)
      : undefined);
  registerTools(server, config, { ...deps, cache });
  return server;
}
