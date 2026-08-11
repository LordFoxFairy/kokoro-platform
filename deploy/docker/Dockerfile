FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@11.2.2 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY kokoro-hub/package.json ./kokoro-hub/package.json
RUN pnpm install --config.auto-install-peers=false --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm rebuild -r && pnpm build:runtime

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS prod-deps

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY kokoro-hub/package.json ./kokoro-hub/package.json
RUN pnpm install --prod --config.auto-install-peers=false --frozen-lockfile --ignore-scripts
RUN rm -rf node_modules/typescript node_modules/.pnpm/typescript@* \
  && rm -f node_modules/.bin/tsc \
  && find node_modules -path '*/.bin/tsc' -delete \
  && find node_modules -type l \( -name typescript -o -name tsc \) -delete

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV KOKORO_SERVICE_PACKAGE=platform-api

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=prod-deps /app/package.json ./package.json
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=prod-deps /app/kokoro-platform-kit/node_modules ./kokoro-platform-kit/node_modules
COPY --chown=node:node --from=build /app/kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY --chown=node:node --from=build /app/kokoro-platform-kit/dist ./kokoro-platform-kit/dist
COPY --chown=node:node --from=prod-deps /app/kokoro-hub/node_modules ./kokoro-hub/node_modules
COPY --chown=node:node --from=build /app/kokoro-hub/package.json ./kokoro-hub/package.json
COPY --chown=node:node --from=build /app/kokoro-hub/dist ./kokoro-hub/dist
COPY --chown=node:node deploy/docker/runtime-entrypoint.mjs ./deploy/docker/runtime-entrypoint.mjs
COPY --chown=node:node scripts/contract/verify-production-image.mjs /opt/kokoro/verify-production-image.mjs

RUN node /opt/kokoro/verify-production-image.mjs /app
USER node
CMD ["node", "--conditions=kokoro-runtime", "deploy/docker/runtime-entrypoint.mjs"]
