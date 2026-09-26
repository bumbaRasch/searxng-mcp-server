#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { cliExit, parseTransportArgv } from './argv.js';
import { assertHttpBindSafety, loadConfig, type Config } from './config.js';
import { startHttpServer } from './http-server.js';
import { SERVER_NAME, createServer } from './server.js';
import { VERSION } from './version.js';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // --help/--version print to stdout and exit 0 before any server startup.
  const exit = cliExit(argv, VERSION);
  if (exit) {
    console.log(exit.message);
    process.exit(exit.code);
  }
  // The CLI flag is explicit intent and throws on typos; env config only warns.
  const argTransport = parseTransportArgv(argv);
  const config = loadConfig(process.env, VERSION, console.error);
  const transport = argTransport ?? config.transport;
  assertHttpBindSafety(transport, config);
  const close = transport === 'http' ? await startHttp(config) : await startStdio(config);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) process.exit(0); // second signal: skip the grace period
    shuttingDown = true;
    // close() waits for in-flight exchanges; bound it so a hung close
    // cannot trap the process until the container SIGKILLs it.
    setTimeout(() => process.exit(0), config.shutdownTimeoutMs).unref();
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startStdio(config: Config): Promise<() => Promise<void>> {
  const server = createServer(config);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's canonical error hook is the onerror property
  server.server.onerror = (error) => {
    console.error(`${SERVER_NAME} protocol error:`, error);
  };
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ${VERSION} running on stdio`);
  return () => server.close();
}

async function startHttp(config: Config): Promise<() => Promise<void>> {
  const handle = await startHttpServer(config);
  console.error(`${SERVER_NAME} ${VERSION} running on ${handle.url} (transport: http)`);
  return () => handle.close();
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
