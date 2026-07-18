FROM node:22-bookworm-slim

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
# 预拷全部 workspace 成员 package.json（与 pnpm-workspace.yaml 对齐）——frozen-lockfile 需全成员对齐,
# 且镜像经 KOKORO_SERVICE_PACKAGE 可跑任一服务(含 hub/platform-admin,原仅 6 个致其依赖缺失/构建断)。
COPY kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY kokoro-i18n/package.json ./kokoro-i18n/package.json
COPY kokoro-platform-admin/package.json ./kokoro-platform-admin/package.json
COPY kokoro-site/package.json ./kokoro-site/package.json
COPY kokoro-user/package.json ./kokoro-user/package.json
COPY kokoro-hub/package.json ./kokoro-hub/package.json
COPY kokoro-model/package.json ./kokoro-model/package.json
COPY kokoro-credit/package.json ./kokoro-credit/package.json
COPY kokoro-payment/package.json ./kokoro-payment/package.json
COPY kokoro-admin-web/package.json ./kokoro-admin-web/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN DATABASE_URL_SITE=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_USER=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_MODEL=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_CREDIT=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_PAYMENT=mysql://placeholder:placeholder@mysql:3306/kokoro \
  pnpm db:generate

ENV NODE_ENV=production
ENV KOKORO_SERVICE_PACKAGE=@kokoro/user

CMD ["sh", "-lc", "pnpm --filter ${KOKORO_SERVICE_PACKAGE} start"]
