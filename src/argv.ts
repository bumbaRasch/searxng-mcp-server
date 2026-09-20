import type { Transport } from './config.js';

const FLAG = '--transport';
const FLAG_EQ = `${FLAG}=`;

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
