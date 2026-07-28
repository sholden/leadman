# syntax=docker/dockerfile:1

# Keep in lockstep with .nvmrc, which CI and local shells read. The hygiene job
# fails the build if these two drift apart. Pinned to the patch so a rebuild of
# an old commit produces the same runtime it originally shipped on.
ARG NODE_VERSION=26.5.0
ARG APP_DIR=/app

# ---------------------------------------------------------------- build stage
FROM node:${NODE_VERSION}-slim AS build
ARG APP_DIR
WORKDIR ${APP_DIR}

# better-sqlite3 has no prebuilt binary for every Node/platform pair, so the
# image must be able to compile it. These are build-only and never shipped.
RUN apt-get update -qq \
 && apt-get install --no-install-recommends -y build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install with the lockfile first so the layer caches on source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# Build the front end, then drop dev dependencies from the tree we ship.
COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# -------------------------------------------------------------- runtime stage
FROM node:${NODE_VERSION}-slim AS runtime
ARG APP_DIR
WORKDIR ${APP_DIR}

ENV NODE_ENV=production \
    PORT=8787 \
    # Lives on the mounted volume, not in the image — see config/deploy.yml.
    LEADMAN_DB=/data/leadman.db

# curl backs the HEALTHCHECK below; sqlite3 makes the `kamal db` and
# `kamal spend` aliases work for inspecting production state on the host.
RUN apt-get update -qq \
 && apt-get install --no-install-recommends -y curl sqlite3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# node:slim ships an unprivileged `node` user (uid 1000); run as it rather than
# root. Creating /data here and chowning it matters: a named volume mounted on
# an existing path inherits that path's ownership on first creation, which is
# what lets the non-root process write the database.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

COPY --from=build --chown=node:node ${APP_DIR}/node_modules ./node_modules
COPY --from=build --chown=node:node ${APP_DIR}/dist ./dist
COPY --from=build --chown=node:node ${APP_DIR}/package.json ./package.json
# The server runs from TypeScript source via tsx, so src ships too. This keeps
# schema.sql resolving next to its module and avoids a separate emit step.
COPY --from=build --chown=node:node ${APP_DIR}/src ./src
COPY --from=build --chown=node:node ${APP_DIR}/tsconfig.json ./tsconfig.json

USER node
EXPOSE 8787

# Kamal's proxy has its own healthcheck; this one makes `docker ps` honest for
# anyone looking at the host directly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["npx", "tsx", "src/server/index.ts"]
