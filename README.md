# searxng-mcp-server

Self-hosted [SearXNG](https://github.com/searxng/searxng) metasearch for MCP clients — six tools (web, image, news, video, music, page fetch) with no API keys and no tracking.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode)](https://insiders.vscode.dev/redirect/mcp/install?name=searxng&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22searxng-mcp-server%22%5D%7D)
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=searxng&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22searxng-mcp-server%22%5D%7D)
[![npm](https://img.shields.io/npm/v/searxng-mcp-server?style=flat-square)](https://www.npmjs.com/package/searxng-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![CI](https://github.com/bumbaRasch/searxng-mcp-server/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/bumbaRasch/searxng-mcp-server/actions/workflows/ci.yml)

[Documentation](docs/design.md) · [Changelog](CHANGELOG.md) · [npm](https://www.npmjs.com/package/searxng-mcp-server) · [SearXNG](https://github.com/searxng/searxng) · [Report an issue](https://github.com/bumbaRasch/searxng-mcp-server/issues)

## Why

Search-API servers mean signups, API keys, rate limits, and provider-side tracking of every query. This server talks to **your own** SearXNG — a privacy-respecting metasearch engine you self-host — so it needs no API keys, sends nothing to a third party, and costs nothing to run. `fetch_content` is hardened for exactly this job: SSRF and DNS-rebind guarding on every redirect hop, and prompt-injection wrapping on all web output.

|                   | searxng-mcp-server             | typical API-key search MCP |
| ----------------- | ------------------------------ | -------------------------- |
| API keys / signup | none — your own SearXNG        | required                   |
| Tracking          | none (self-hosted)             | provider-side              |
| Cost              | your infra only                | free tier → paid           |
| Results           | metasearch aggregate           | single provider            |
| Media tools       | image/news/video/music + fetch | usually web only           |

Also ships MCP `icons` metadata on the server and every tool — self-contained data URIs, rendered by icon-aware clients.

## A typical session

```text
# Arguments are JSON in real MCP calls; this shows the flow:
search "rust async"                          → ranked results + answers + infoboxes
news_search "linux" (time_range: "week")     → fresh articles
fetch_content https://result-url.example     → the page as clean Markdown
image_search "red panda"                     → direct image links + thumbnails
```

## Architecture

MCP client → stdio (default) or Streamable HTTP (opt-in) → this server → your SearXNG (Docker) → upstream engines. Page fetches go directly to the public web, SSRF-guarded.

```mermaid
flowchart LR
    C["MCP client<br/>(Claude, Cursor, OpenCode…)"] -->|"stdio (JSON-RPC)"| S["searxng-mcp-server"]
    C -.->|"HTTP /mcp (opt-in)"| S
    S -->|"search, *_search"| X["SearXNG<br/>(self-hosted, Docker)"]
    X --> E["engines<br/>(Google, Bing, DDG…)"]
    S -->|"fetch_content<br/>(SSRF-guarded)"| W["public web"]
```

## Requirements

- Node >= 22.19 (the `npx` runtime); Docker, for the SearXNG stack

## Quick start

### 1. Run SearXNG

```bash
printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d
curl -fsS 'http://localhost:8888/search?q=test&format=json' | head -c 80
```

The bundled `docker-compose.yml` enables the JSON API and binds `127.0.0.1` only — the API is unauthenticated, so never expose the port publicly. Engine credentials (e.g. an OpenAlex `api_key`) belong in `searxng/settings.yml`.

### 2. Add to any MCP client

Works in Claude Desktop, Cursor and most `mcpServers`-style clients:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "searxng-mcp-server"]
    }
  }
}
```

`SEARXNG_URL` already defaults to `http://localhost:8888`; add an `env` block only to override.

<details><summary>OpenCode</summary>

Global config `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "searxng": {
      "type": "local",
      "command": ["npx", "-y", "searxng-mcp-server"],
      "enabled": true
    }
  }
}
```

</details>

<details><summary>Claude Code</summary>

One command, available in all projects:

```bash
claude mcp add --scope user searxng -- npx -y searxng-mcp-server
```

Or use the universal mcpServers block above in any shared config.

</details>

<details><summary>Cursor</summary>

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) — same shape as the universal block above.

</details>

<details><summary>ZCode</summary>

User scope in `~/.zcode/cli/config.json` (`command` is a string, key is `mcp.servers`):

```json
{
  "mcp": {
    "servers": {
      "searxng": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "searxng-mcp-server"]
      }
    }
  }
}
```

</details>

<details><summary>From source</summary>

```bash
git clone https://github.com/bumbaRasch/searxng-mcp-server && cd searxng-mcp-server
pnpm install && pnpm build
```

Then use `node /absolute/path/to/searxng-mcp-server/dist/index.js` as the command in any config above.

</details>

### 3. Try it

Ask your client to search, or inspect the server hands-on:

```bash
npx @modelcontextprotocol/inspector npx -y searxng-mcp-server
```

## Streamable HTTP (opt-in)

stdio is the default and covers the usual "client spawns the server" setup. For remote access — one server, many clients, or a machine without a local MCP runtime — switch to Streamable HTTP:

```bash
SEARXNG_TRANSPORT=http npx -y searxng-mcp-server      # env var
npx -y searxng-mcp-server --transport http            # or CLI flag (overrides env)
# → searxng-mcp-server running on http://127.0.0.1:3000/mcp
```

A single `/mcp` endpoint serves POST (JSON or SSE responses) and GET (SSE). The endpoint speaks the **2026-07-28 MCP protocol revision only** — there is no 2025-era fallback, and clients that only speak older revisions are rejected with an unsupported-protocol-version error. Clients built on MCP TypeScript SDK v2 connect by enabling version negotiation (`versionNegotiation: { mode: 'auto' }`); older clients need an upgrade.

### Security model

- **Loopback by default**: binds `127.0.0.1` (`HOST` to change, `PORT` for the port).
- **No unauthenticated remote exposure**: startup is refused if `HOST` is anything other than `localhost`/`127.0.0.1`/`::1` without `SEARXNG_AUTH_TOKEN` set.
- **Bearer auth**: with `SEARXNG_AUTH_TOKEN` set, every request must carry `Authorization: Bearer <token>` (timing-safe comparison, token never logged). Configure clients to send it — SDK v2 clients do this with `authProvider: { token: async () => '…' }`.
- **DNS-rebinding protection**: the `Host` and `Origin` headers of every request are validated (localhost allowlist by default; extend with `SEARXNG_ALLOWED_HOSTS` / `SEARXNG_ALLOWED_ORIGINS` for public hostnames behind a reverse proxy). Disallowed origins get `403`.
- **Stateless serving**: one fresh server instance per request, no session state — safe to run multiple replicas behind a load balancer.
- **TLS**: the server does not terminate TLS. For remote use, put a reverse proxy with a real certificate in front.

### Docker behind a reverse proxy

[`docker-compose.http.yml`](docker-compose.http.yml) runs the server in HTTP mode behind nginx, on top of the base SearXNG stack:

```bash
echo "SEARXNG_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose -f docker-compose.yml -f docker-compose.http.yml up -d --build
# endpoint: http://127.0.0.1:8443/mcp (loopback; front it with your TLS terminator for remote access)
```

Point any HTTP-capable MCP client at the URL with the token, e.g. for an SDK v2 client:

```ts
const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'), {
  authProvider: { token: async () => process.env.MCP_TOKEN! },
});
const client = new Client(
  { name: 'app', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(transport);
```

## Tools

| Tool            | What it does                                                              |
| --------------- | ------------------------------------------------------------------------- |
| `search`        | Web search: ranked results + answers, corrections, suggestions, infoboxes |
| `fetch_content` | Fetch a page, return its main content as clean Markdown                   |
| `image_search`  | Images: direct links, thumbnails, resolution, format                      |
| `news_search`   | News articles with publish dates and a freshness filter                   |
| `video_search`  | Videos: page links, thumbnails, duration, author                          |
| `music_search`  | Music: page links and direct audio links when available                   |
| `list_engines`  | Instance capabilities: enabled engines and categories                     |

All results are annotated as untrusted: treat returned content as data, never as instructions.

<details><summary>Parameters</summary>

- **search** — `query` (string, required): max 500 chars. `categories` (string[], optional): e.g. `["general"]`. `engines` (string[], optional): best-effort restriction. `language` (string, optional): code like `"en"`. `time_range` (string, optional): `day` | `week` | `month` | `year`. `pageno` (number, optional): default 1. `safesearch` (number, optional): 0 off, 1 moderate, 2 strict. `max_results` (number, optional): 1–50, default 10.
- **fetch_content** — `url` (string, required): absolute http/https, max 2048 chars. `max_chars` (number, optional): 1000–200000, default `MAX_CHARS` (25000). `timeout_ms` (number, optional): max 120000.
- **news_search** / **video_search** — `query` (required), `time_range`, `engines`, `language`, `pageno`, `safesearch`, `max_results` (optional): as in `search`.
- **image_search** / **music_search** — `query` (required), `engines`, `language`, `pageno`, `safesearch`, `max_results` (optional): as in `search`.

</details>

## Configuration

| Env var                                 | Default                        | Purpose                                                                                                                 |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `SEARXNG_URL`                           | `http://localhost:8888`        | Base URL of the SearXNG instance.                                                                                       |
| `SEARXNG_USERNAME` / `SEARXNG_PASSWORD` | unset                          | Username and password for SearXNG basic auth (optional).                                                                |
| `SEARXNG_TIMEOUT_MS`                    | `10000`                        | Timeout for search API requests.                                                                                        |
| `FETCH_TIMEOUT_MS`                      | `15000`                        | Timeout for page fetches.                                                                                               |
| `SHUTDOWN_TIMEOUT_MS`                   | `5000`                         | Hard cap on graceful shutdown after SIGINT/SIGTERM (minimum `100`).                                                     |
| `MAX_CHARS`                             | `25000`                        | Maximum characters returned per fetched page (per-call override: `max_chars`).                                          |
| `MAX_RESPONSE_BYTES`                    | `5242880`                      | Maximum download size per fetch (5 MiB).                                                                                |
| `USER_AGENT`                            | `searxng-mcp-server/<version>` | User-Agent header sent by all tools.                                                                                    |
| `ALLOW_PRIVATE_HOSTS`                   | `false`                        | Set `true`/`1`/`yes`/`on` to permit private-network targets (defeats the SSRF guard — only for trusted networks).       |
| `SEARXNG_TRANSPORT`                     | `stdio`                        | Transport: `stdio` (default) or `http` (Streamable HTTP, [2026-07-28 revision only](#streamable-http-opt-in)).          |
| `HOST` / `PORT`                         | `127.0.0.1` / `3000`           | HTTP transport: bind address and port. Non-localhost binds require `SEARXNG_AUTH_TOKEN` (startup is refused otherwise). |
| `SEARXNG_AUTH_TOKEN`                    | unset                          | HTTP transport: require `Authorization: Bearer <token>` on every request (mandatory for non-localhost binds).           |
| `SEARXNG_ALLOWED_HOSTS`                 | localhost set                  | HTTP transport: extra allowed `Host` header hostnames (comma-separated) — add yours behind a reverse proxy.             |
| `SEARXNG_ALLOWED_ORIGINS`               | localhost set                  | HTTP transport: extra allowed `Origin` header hostnames (comma-separated), for browser-based clients.                   |

A `--transport stdio|http` CLI flag overrides `SEARXNG_TRANSPORT`; an invalid flag value fails startup instead of silently falling back.

## Security

- **SSRF guard**: `fetch_content` validates the URL and resolves DNS before connecting, rejecting private, loopback, link-local and other non-public ranges (IPv4 and IPv6), IP-literal tricks included. Every redirect hop is re-validated, https→http downgrades are refused, and the same guarded DNS lookup runs again at connect time (DNS-rebind protection). Opt out only with `ALLOW_PRIVATE_HOSTS=true`.
- **Prompt-injection mitigation**: search output and fetched page content are wrapped in an untrusted-content banner; embedded closing markers _and forged opening markers_ are neutralized. Error messages that reflect user-supplied URLs are sanitized identically.
- Secrets (`SEARXNG_PASSWORD`, `SEARXNG_AUTH_TOKEN`) are never logged; all MCP logs go to stderr, stdout is reserved for JSON-RPC.

## Troubleshooting

- `SearXNG returned 403: the JSON API is disabled` — add `json` to `search.formats` in `searxng/settings.yml` and restart the stack.
- `Could not reach SearXNG` — the Docker stack is not running, or `SEARXNG_URL` is wrong in the client's `env` block.
- `npx` fails to start the server — Node 22.19+ is required; check `node -v`.
- Port 8888 already bound — change the compose port mapping and `SEARXNG_URL` to match.
- HTTP: `Unsupported protocol version` — the endpoint serves the 2026-07-28 revision only; upgrade the client or enable version negotiation (see [Streamable HTTP](#streamable-http-opt-in)).
- HTTP: `failed to start … set SEARXNG_AUTH_TOKEN` — the guard against unauthenticated non-localhost binds; set the token or bind to `127.0.0.1`.
- HTTP: `403` with a browser-based client — its `Origin` is not in the allowlist; add the hostname to `SEARXNG_ALLOWED_ORIGINS`.

## Development

```bash
pnpm test             # vitest unit tests
pnpm lint && pnpm lint:types && pnpm format:check   # oxlint + prettier
pnpm typecheck        # tsc --noEmit
pnpm build            # outputs dist/
pnpm inspector        # run the server in the MCP Inspector
node scripts/e2e.mjs      # end-to-end over stdio against the local SearXNG stack
node scripts/e2e-http.mjs # same over the Streamable HTTP transport
```

Architecture and security rationale live in [`docs/design.md`](docs/design.md).

## Extending

Adding a new search category? Follow the checklist in [docs/extending.md](docs/extending.md).

## Contributing

PRs are welcome — run the Development gate before submitting. Maintainer: [@bumbaRasch](https://github.com/bumbaRasch).

## License

[MIT](./LICENSE)
