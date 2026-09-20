import { McpServer } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { SERVER_ICONS } from './icon.js';
import { registerTools, type ToolDeps } from './tools.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'searxng-mcp-server';

/** Builds a transport-agnostic MCP server; `index.ts` wires it to stdio. */
export function createServer(config: Config, deps: ToolDeps = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
    icons: SERVER_ICONS,
  });
  registerTools(server, config, deps);
  return server;
}
