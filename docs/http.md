# Streamable HTTP (opt-in)

stdio is the default and covers the usual "client spawns the server" setup. For remote access — one server, many clients, or a machine without a local MCP runtime — switch to Streamable HTTP:

```bash
SEARXNG_TRANSPORT=http npx -y searxng-mcp-server      # env var
npx -y searxng-mcp-server --transport http            # or CLI flag (overrides env)
# → searxng-mcp-server running on http://127.0.0.1:3000/mcp
```

A single `/mcp` endpoint serves POST (JSON or SSE responses) and GET (SSE). The endpoint speaks the **2026-07-28 MCP protocol revision only** — there is no 2025-era fallback, and clients that only speak older revisions are rejected with an unsupported-protocol-version error. Clients built on MCP TypeScript SDK v2 connect by enabling version negotiation (`versionNegotiation: { mode: 'auto' }`); older clients need an upgrade.

## Liveness probe

`GET /healthz` answers `200 {"status":"ok"}` for compose, Kubernetes and load-balancer probes. It is passive (no SearXNG request, no side effects) and skips the bearer token, but `Host`/`Origin` validation still applies; readiness (is SearXNG actually reachable?) stays the reverse proxy's concern.

```bash
curl -fsS http://127.0.0.1:3000/healthz   # → {"status":"ok"}
```

## Security model

- **Loopback by default**: binds `127.0.0.1` (`HOST` to change, `PORT` for the port).
- **No unauthenticated remote exposure**: startup is refused if `HOST` is anything other than `localhost`/`127.0.0.1`/`::1` without `SEARXNG_AUTH_TOKEN` set.
- **Bearer auth**: with `SEARXNG_AUTH_TOKEN` set, every `/mcp` request must carry `Authorization: Bearer <token>` (timing-safe comparison, token never logged). Configure clients to send it — SDK v2 clients do this with `authProvider: { token: async () => '…' }`. The `/healthz` probe needs no token.
- **DNS-rebinding protection**: the `Host` and `Origin` headers of every request are validated (localhost allowlist by default; extend with `SEARXNG_ALLOWED_HOSTS` / `SEARXNG_ALLOWED_ORIGINS` for public hostnames behind a reverse proxy). Disallowed origins get `403`.
- **Stateless serving**: one fresh server instance per request, no session state; `ref:N`/task session continuity is process-scoped — see [Scaling behind a load balancer](#scaling-behind-a-load-balancer).
- **TLS**: the server does not terminate TLS. For remote use, put a reverse proxy with a real certificate in front.

## Scaling behind a load balancer

Serving is stateless — every request gets a fresh `McpServer` — so a single instance needs nothing special. But three session-continuity stores deliberately live at **process scope**, and replicas do not share them:

- **Citation refs** — `RefRegistry` (`src/refs.ts`): a `ref:N` minted on replica A will not resolve on replica B.
- **Crawled pages** — `PageStore` (`src/crawl.ts`): `crawl_site` content cached for later `fetch_content` stays on the replica that crawled it.
- **Tasks** — `TaskStore` (`src/tasks.ts`): a `taskId` handed out by `deep_search` cannot be polled or cancelled on another replica.

With N replicas behind a load balancer, choose one of the following **before** the first LB deployment — otherwise a client silently loses its `ref:N`/`taskId` between conversational turns:

1. **Sticky routing** at the load balancer: keep each client's requests on one replica. [`nginx/mcp-proxy.conf`](../nginx/mcp-proxy.conf) currently proxies to a single upstream (`proxy_pass http://mcp:3000`) and does no balancing — scaling it up means an `upstream` block with `ip_hash` or consistent hashing.
2. **External store** (Redis/Postgres) behind the existing seams: `RefRegistry`, `PageStore` and `TaskStore` are plain classes injected through `ToolDeps`, so replacing their backing storage is a contained change.

This is a documented, deliberate limitation; the default single-instance deployment (including the compose setup above) is unaffected.

## Docker behind a reverse proxy

[`docker-compose.http.yml`](../docker-compose.http.yml) runs the server in HTTP mode behind nginx, on top of the base SearXNG stack:

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

## See also

- [Configuration](../README.md#configuration) — full env-var table.
- [Troubleshooting](../README.md#troubleshooting) — HTTP error hints.
- [Design](design.md) — architecture and security rationale.
