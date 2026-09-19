#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type Config } from './config.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';

export function createServer(config: Config = loadConfig(process.env, VERSION)): McpServer {
  const server = new McpServer({ name: 'searxng-mcp-ts', version: VERSION });
  registerTools(server, config);
  return server;
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env, VERSION);
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`searxng-mcp-ts ${VERSION} running on stdio`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error('searxng-mcp-ts failed to start:', error);
    process.exit(1);
  });
}
