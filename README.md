# searxng-mcp-ts

MCP server for a self-hosted SearXNG instance: web search (`search`) and page
fetch (`fetch_content`), no API keys.

## Local SearXNG (Docker)

```bash
cp .env.example .env
printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose up -d
curl -fsS 'http://localhost:8888/search?q=searxng&format=json'
```

## Configuration

- `.env` is read **ONLY by Docker Compose** (for `SEARXNG_SECRET`).
  The MCP server does **not** load `.env` — its configuration (`SEARXNG_URL`,
  etc.) is supplied by the MCP client via the `environment` block, e.g.:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": { "SEARXNG_URL": "http://localhost:8888" }
    }
  }
}
```

- `SEARXNG_URL` — base URL of the SearXNG instance (default `http://localhost:8888`).

## Development

```bash
pnpm install
pnpm build          # outputs dist/
pnpm test           # vitest
pnpm lint && pnpm lint:types
node scripts/e2e.mjs   # end-to-end against the local SearXNG
```
