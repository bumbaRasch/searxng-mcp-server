# Security Policy

## Supported versions

Security fixes are released only for the latest published version.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3.x | ❌        |

## Reporting a vulnerability

Do **not** open a public issue for a security vulnerability.

Report it privately via GitHub **Private vulnerability reporting**: in the repository, open the **Security** tab → **Report a vulnerability**. If that option is unavailable, contact the maintainer [@bumbaRasch](https://github.com/bumbaRasch) through a private channel.

Please include:

- the affected version (the `searxng-mcp-server` npm package version in use),
- steps or a minimal reproduction,
- your assessment of the impact.

This is a single-maintainer, best-effort project: expect an acknowledgment within a few days. Reports are handled as coordinated disclosures and published as GitHub security advisories, with credit to the reporter unless anonymity is requested. There are no bug bounties.

## Scope

**In scope**

- The server source code (`src/`), including the `fetch_content` SSRF/DNS-rebind guard and prompt-injection wrapping.
- The opt-in Streamable HTTP transport: bearer-token auth, `Host`/`Origin` validation, non-localhost bind guard.
- The shipped Docker stack (`docker-compose.yml`, `docker-compose.http.yml`, `nginx/`, `searxng/`) and secret handling (`SEARXNG_PASSWORD`, `SEARXNG_AUTH_TOKEN` are never logged).

**Out of scope**

- Vulnerabilities in [SearXNG](https://github.com/searxng/searxng) itself — report upstream.
- Vulnerabilities in dependencies that are not exploitable through this server — report upstream (Renovate tracks updates).
- Consequences of documented opt-ins: running with `ALLOW_PRIVATE_HOSTS=true`, exposing the unauthenticated SearXNG API, or a token-less non-loopback HTTP bind.
- The operator's own infrastructure and reverse-proxy configuration.
