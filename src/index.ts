#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { SERVER_NAME, createServer } from './server.js';
import { VERSION } from './version.js';

export async function main(): Promise<void> {
  const config = loadConfig(process.env, VERSION, console.error);
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ${VERSION} running on stdio`);
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
    console.error(`${SERVER_NAME} failed to start:`, error);
    process.exit(1);
  });
}
