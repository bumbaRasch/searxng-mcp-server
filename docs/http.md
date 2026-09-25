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
- **Stateless serving**: one fresh server instance per request, no session state — safe to run multiple replicas behind a load balancer.
- **TLS**: the server does not terminate TLS. For remote use, put a reverse proxy with a real certificate in front.

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
