# One build, two images.
#
#   build  -> installs dependencies and compiles shared, server and client
#   server -> the authoritative game server (Node, WebSocket + /api)
#   web    -> nginx that serves the built client and proxies /api and /ws to the server
#
# The client always talks to its own origin, so the browser only ever sees one host.

FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.15.0

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
RUN pnpm build


FROM node:24-slim AS server
WORKDIR /app
ENV NODE_ENV=production \
    PORT=2567 \
    STRIKECORE_RATINGS_PATH=/data/ratings.json
# The workspace is reused as-is: pnpm links packages through symlinks, so copying it whole is the safest way to keep them intact.
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 2567
CMD ["node", "packages/server/dist/index.js"]


FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/client/dist /usr/share/nginx/html
EXPOSE 80
