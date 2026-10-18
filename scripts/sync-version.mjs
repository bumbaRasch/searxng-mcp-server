// Release-version sync for the `pnpm version` lifecycle. `pnpm version` bumps
// package.json, commits and tags, but does not touch src/version.ts or
// server.json. This script runs from the "version" lifecycle hook, which
// executes after package.json has been bumped but before the release commit
// and tag are created (npm version lifecycle order), so the hook git-adds the
// synced files into the release commit that the v* tag points at.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// npm and pnpm export npm_new_version to the "version" hook; when the script
// is run by hand, fall back to package.json, which is already bumped at this
// point in the lifecycle.
const version =
  process.env.npm_new_version ?? JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
if (!versionPattern.test(version)) {
  console.error(`sync-version.mjs: refusing invalid version ${JSON.stringify(version)}`);
  process.exit(1);
}

writeFileSync(`${root}src/version.ts`, `export const VERSION = '${version}';\n`);

// JSON.parse/JSON.stringify preserves key order and emits 2-space indentation;
// the trailing newline matches the committed file.
const server = JSON.parse(readFileSync(`${root}server.json`, 'utf8'));
if (!Array.isArray(server.packages) || server.packages.length === 0) {
  console.error('sync-version.mjs: server.json has no packages[0] to sync');
  process.exit(1);
}
server.version = version;
server.packages[0].version = version;
writeFileSync(`${root}server.json`, `${JSON.stringify(server, null, 2)}\n`);

console.log(`sync-version.mjs: src/version.ts and server.json set to ${version}`);
