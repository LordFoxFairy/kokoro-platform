FROM node:22-bookworm-slim

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable

# pnpm 网络韧性：降并发 + 多重试 + 长超时（flaky 网络/CI 抗 RST）。
ENV npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_network_concurrency=4

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
# 预拷全部 workspace 成员 package.json（与 pnpm-workspace.yaml 对齐）——frozen-lockfile 需全成员对齐,
# 且镜像经 KOKORO_SERVICE_PACKAGE 可跑任一服务(含 hub/platform-admin,原仅 6 个致其依赖缺失/构建断)。
COPY kokoro-platform-kit/package.json ./kokoro-platform-kit/package.json
COPY kokoro-platform-admin/package.json ./kokoro-platform-admin/package.json
COPY kokoro-site/package.json ./kokoro-site/package.json
COPY kokoro-user/package.json ./kokoro-user/package.json
COPY kokoro-hub/package.json ./kokoro-hub/package.json
COPY kokoro-model/package.json ./kokoro-model/package.json
COPY kokoro-credit/package.json ./kokoro-credit/package.json
COPY kokoro-payment/package.json ./kokoro-payment/package.json

# --ignore-scripts：install 阶段只拷了各包 package.json,prisma schema 尚未 COPY 进来,
# 各包 postinstall(prisma generate) 此时必因 "schema.prisma: file not found" 失败并中断 frozen 装配。
# 依赖原生构建(@prisma/engines / esbuild 等,allowBuilds 已批准)延后到源码就位后由 pnpm rebuild 补做。
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# 源码就位后补跑依赖原生构建脚本(prisma engines 下载 / esbuild 二进制——tsx 运行时依赖),
# 再显式生成各包 prisma client。generate 需 datasource env 存在(不连库),含 platform-admin/admin-web
# 用的 DATABASE_URL_ADMIN,故一并给占位,否则报 "env not found" 断构建。
RUN DATABASE_URL_SITE=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_USER=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_MODEL=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_CREDIT=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_PAYMENT=mysql://placeholder:placeholder@mysql:3306/kokoro \
  DATABASE_URL_ADMIN=mysql://placeholder:placeholder@mysql:3306/kokoro \
  sh -c "pnpm rebuild -r && pnpm db:generate"

ENV NODE_ENV=production
ENV KOKORO_SERVICE_PACKAGE=@kokoro/user

CMD ["sh", "-lc", "pnpm --filter ${KOKORO_SERVICE_PACKAGE} start"]
