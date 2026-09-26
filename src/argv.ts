import type { Transport } from './config.js';

const FLAG = '--transport';
const FLAG_EQ = `${FLAG}=`;

/** Terminal output for `--help`/`--version`: text for stdout plus the exit code. */
export interface CliExit {
  code: number;
  message: string;
}

const USAGE = `Usage: searxng-mcp-server [--transport stdio|http] [--version] [--help]

MCP server for a self-hosted SearXNG instance. Configuration is read from the
environment (SEARXNG_URL, SEARXNG_TRANSPORT, ...); see README.md.

Options:
  --transport <stdio|http>  Override the transport (default: SEARXNG_TRANSPORT, else stdio)
  --version                 Print the version and exit
  --help                    Print this help and exit`;

/**
 * `--help`/`--version` output to print on stdout with exit code 0, or
 * `undefined` to continue startup. `--help` wins when both are present.
 */
export function cliExit(argv: readonly string[], version: string): CliExit | undefined {
  if (argv.includes('--help')) return { code: 0, message: USAGE };
  if (argv.includes('--version')) return { code: 0, message: version };
  return undefined;
}

/**
 * `--transport stdio|http` override; `undefined` when absent (env decides).
 * Throws on a present-but-invalid value — a flag is explicit intent. Unrelated
 * arguments are ignored (MCP clients sometimes append their own).
 */
export function parseTransportArgv(argv: readonly string[]): Transport | undefined {
  for (const [i, arg] of argv.entries()) {
    let value: string | undefined;
    if (arg === FLAG) {
      value = argv[i + 1];
    } else if (arg.startsWith(FLAG_EQ)) {
      value = arg.slice(FLAG_EQ.length);
    } else {
      continue;
    }
    if (value === 'stdio' || value === 'http') return value;
    throw new Error(
      `${FLAG}: expected "stdio" or "http", got ${value === undefined ? 'nothing' : `"${value}"`}`,
    );
  }
  return undefined;
}
