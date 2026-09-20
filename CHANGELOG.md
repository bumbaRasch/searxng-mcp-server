# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Security policy (`SECURITY.md`): private vulnerability reporting via GitHub, supported versions and scope.

### Changed

- Streamable HTTP documentation moved from the README to [docs/http.md](docs/http.md); the README keeps a short overview.

## [0.3.1] - 2026-09-20

### Security

- The non-localhost HTTP bind guard now also covers the `--transport http` flag path (previously only `SEARXNG_TRANSPORT=http` was validated, letting the flag start an unauthenticated server on an exposed interface).

## [0.3.0] - 2026-09-20

### Added

- Opt-in Streamable HTTP transport alongside stdio ([#9](https://github.com/bumbaRasch/searxng-mcp-server/issues/9)): `SEARXNG_TRANSPORT=http` or `--transport http` serves a single `/mcp` endpoint speaking the 2026-07-28 MCP protocol revision only (no 2025-era fallback, stateless per-request serving — no `Mcp-Session-Id` sessions). stdio remains the default; existing `npx` setups are unchanged.
- HTTP security: loopback bind by default (`HOST`/`PORT`); startup refused on a non-localhost bind without `SEARXNG_AUTH_TOKEN`; optional bearer-token auth (`401`/`403` with `WWW-Authenticate`, timing-safe compare); `Host`/`Origin` validation on every request (localhost allowlist + `SEARXNG_ALLOWED_HOSTS`/`SEARXNG_ALLOWED_ORIGINS`) for DNS-rebinding protection.
- Docker deployment: `Dockerfile` and `docker-compose.http.yml` — the server in HTTP mode behind an nginx reverse proxy on top of the base SearXNG stack.

## [0.2.0] - 2026-09-20

### Added

- `list_engines` tool: discovery of the engines and categories enabled on the connected SearXNG instance (via `/config`) — makes the `engines` parameter of the search tools instance-aware ([#8](https://github.com/bumbaRasch/searxng-mcp-server/issues/8)).

## [0.1.2] - 2026-09-20

### Added

- MCP `icons` metadata (SEP-973) for the server and every tool — self-contained data URIs, rendered by icon-aware clients.
- Coverage gate: vitest thresholds enforced in CI (`pnpm test:coverage`) plus a successful `tools/call` transport test.
- OIDC release workflow: tag `v*` → npm publish with provenance + GitHub Release (no tokens, no OTP).
- GitHub issue forms (bug report, feature request, tool request) with a router — no blank issues.
- Listing metadata: `server.json` (official MCP Registry), `smithery.yaml`, `glama.json`, npm `mcpName`/`repository` provenance.
- Renovate dependency automation (pinned-action updates, npm release-age security delay).

### Changed

- npm package renamed to `searxng-mcp-server` (`searxng-mcp-ts` was taken on npm); the GitHub repository keeps the matching name.
- `actions/checkout` updated to v7.

## [0.1.1] - 2026-09-20

### Added

- npm provenance metadata (`mcpName`, `repository`) required by the official MCP Registry ownership verification.

## [0.1.0] - 2026-09-20

### Added

- Initial public release: six tools for a self-hosted SearXNG instance — `search`, `fetch_content`, `image_search`, `news_search`, `video_search`, `music_search`.
- SSRF and DNS-rebind guard on page fetch: pre-validation on every redirect hop, connect-time re-check, private/reserved range blocking, https→http downgrade refusal.
- Prompt-injection mitigation: untrusted-content wrapping with marker neutralization; sanitized error text.
- MCP `icons`, tool annotations, `outputSchema` validation, stdin/stdout hygiene (stderr-only logs).
- Bundled SearXNG Docker stack (pinned image, loopback-only) and end-to-end verification script.
- 260 unit tests, CI matrix (Node 22.19/24/26), type-aware linting, coverage.

[Unreleased]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.2.0
[0.1.2]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://www.npmjs.com/package/searxng-mcp-server/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/searxng-mcp-server/v/0.1.0
