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
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's canonical error hook is the onerror property
  server.server.onerror = (error) => {
    console.error(`${SERVER_NAME} protocol error:`, error);
  };
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ${VERSION} running on stdio`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) process.exit(0); // second signal: skip the grace period
    shuttingDown = true;
    // SDK close() waits for in-flight exchanges; bound it so a hung close
    // cannot trap the process until the container SIGKILLs it.
    setTimeout(() => process.exit(0), config.shutdownTimeoutMs).unref();
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
