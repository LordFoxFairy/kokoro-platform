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
COPY kokoro-platform-admin/package.json ./kokoro-platform-admin/package.json
COPY kokoro-site/package.json ./kokoro-site/package.json
COPY kokoro-user/package.json ./kokoro-user/package.json
COPY kokoro-hub/package.json ./kokoro-hub/package.json
COPY kokoro-model/package.json ./kokoro-model/package.json
COPY kokoro-credit/package.json ./kokoro-credit/package.json
COPY kokoro-payment/package.json ./kokoro-payment/package.json
RUN pnpm install --config.auto-install-peers=false --frozen-lockfile --ignore-scripts

COPY . .
RUN DATABASE_URL_SITE=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_USER=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_MODEL=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_CREDIT=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_PAYMENT=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_ADMIN=mysql://placeholder:placeholder@mysql:3306/kokoro \
  sh -c "pnpm rebuild -r && pnpm db:generate && pnpm build:runtime"

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS prod-deps

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY kokoro-platform-admin/package.json ./kokoro-platform-admin/package.json
COPY kokoro-site/package.json ./kokoro-site/package.json
COPY kokoro-user/package.json ./kokoro-user/package.json
COPY kokoro-hub/package.json ./kokoro-hub/package.json
COPY kokoro-model/package.json ./kokoro-model/package.json
COPY kokoro-credit/package.json ./kokoro-credit/package.json
COPY kokoro-payment/package.json ./kokoro-payment/package.json
RUN pnpm install --prod --no-optional --config.auto-install-peers=false --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV KOKORO_SERVICE_PACKAGE=@kokoro/user

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=prod-deps /app/package.json ./package.json
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=prod-deps /app/kokoro-platform-kit/node_modules ./kokoro-platform-kit/node_modules
COPY --chown=node:node --from=build /app/kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY --chown=node:node --from=build /app/kokoro-platform-kit/dist ./kokoro-platform-kit/dist
COPY --chown=node:node --from=prod-deps /app/kokoro-platform-admin/node_modules ./kokoro-platform-admin/node_modules
COPY --chown=node:node --from=build /app/kokoro-platform-admin/package.json ./kokoro-platform-admin/package.json
COPY --chown=node:node --from=build /app/kokoro-platform-admin/dist ./kokoro-platform-admin/dist
COPY --chown=node:node --from=build /app/kokoro-platform-admin/generated ./kokoro-platform-admin/generated
COPY --chown=node:node --from=build /app/kokoro-platform-admin/public ./kokoro-platform-admin/public
COPY --chown=node:node --from=prod-deps /app/kokoro-site/node_modules ./kokoro-site/node_modules
COPY --chown=node:node --from=build /app/kokoro-site/package.json ./kokoro-site/package.json
COPY --chown=node:node --from=build /app/kokoro-site/dist ./kokoro-site/dist
COPY --chown=node:node --from=build /app/kokoro-site/generated ./kokoro-site/generated
COPY --chown=node:node --from=prod-deps /app/kokoro-user/node_modules ./kokoro-user/node_modules
COPY --chown=node:node --from=build /app/kokoro-user/package.json ./kokoro-user/package.json
COPY --chown=node:node --from=build /app/kokoro-user/dist ./kokoro-user/dist
COPY --chown=node:node --from=build /app/kokoro-user/generated ./kokoro-user/generated
COPY --chown=node:node --from=prod-deps /app/kokoro-hub/node_modules ./kokoro-hub/node_modules
COPY --chown=node:node --from=build /app/kokoro-hub/package.json ./kokoro-hub/package.json
COPY --chown=node:node --from=build /app/kokoro-hub/dist ./kokoro-hub/dist
COPY --chown=node:node --from=prod-deps /app/kokoro-model/node_modules ./kokoro-model/node_modules
COPY --chown=node:node --from=build /app/kokoro-model/package.json ./kokoro-model/package.json
COPY --chown=node:node --from=build /app/kokoro-model/dist ./kokoro-model/dist
COPY --chown=node:node --from=build /app/kokoro-model/generated ./kokoro-model/generated
COPY --chown=node:node --from=prod-deps /app/kokoro-credit/node_modules ./kokoro-credit/node_modules
COPY --chown=node:node --from=build /app/kokoro-credit/package.json ./kokoro-credit/package.json
COPY --chown=node:node --from=build /app/kokoro-credit/dist ./kokoro-credit/dist
COPY --chown=node:node --from=build /app/kokoro-credit/generated ./kokoro-credit/generated
COPY --chown=node:node --from=prod-deps /app/kokoro-payment/node_modules ./kokoro-payment/node_modules
COPY --chown=node:node --from=build /app/kokoro-payment/package.json ./kokoro-payment/package.json
COPY --chown=node:node --from=build /app/kokoro-payment/dist ./kokoro-payment/dist
COPY --chown=node:node --from=build /app/kokoro-payment/generated ./kokoro-payment/generated
COPY --chown=node:node deploy/docker/runtime-entrypoint.mjs ./deploy/docker/runtime-entrypoint.mjs
COPY --chown=node:node scripts/contract/verify-production-image.mjs /opt/kokoro/verify-production-image.mjs

RUN node /opt/kokoro/verify-production-image.mjs /app
USER node
CMD ["node", "--conditions=kokoro-runtime", "deploy/docker/runtime-entrypoint.mjs"]
