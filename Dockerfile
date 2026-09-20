# syntax=docker/dockerfile:1
# Builds the MCP server image. stdio by default; set SEARXNG_TRANSPORT=http
# (plus HOST/PORT and, for non-localhost binds, SEARXNG_AUTH_TOKEN) to serve
# Streamable HTTP instead — see docker-compose.http.yml for a reverse-proxy
# example.

FROM docker.io/library/node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM docker.io/library/node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
