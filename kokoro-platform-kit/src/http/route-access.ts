import type { FastifyInstance, FastifyRequest } from "fastify";
import { INTERNAL_SECRET_HEADER } from "./internal-secret-guard.js";
import { sendError } from "./responses.js";

// 调用方声明自己的服务身份；服务端据此在等级 allowlist 内定位该 caller 的期望 secret。
export const SERVICE_CALLER_HEADER = "x-kokoro-service";

// 四类访问等级（D2）：public 无需凭据；其余按 caller allowlist + per-caller secret 校验。
export const ACCESS_LEVELS = ["public", "runtime-internal", "web-bff", "admin"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

// 已知调用方身份；每个 caller 有独立 secret（env KOKORO_INTERNAL_SECRET_<CALLER>）。
// 新增 caller 时同步扩展；未列入者一律被视为未知调用方（401）。
export const SERVICE_CALLERS = [
  "session",
  "agent",
  "web-bff",
  "admin",
  "hub",
  "payment",
  "credit",
  "model",
  "site",
  "user",
] as const;
export type ServiceCaller = (typeof SERVICE_CALLERS)[number];

const CALLER_SET: ReadonlySet<string> = new Set(SERVICE_CALLERS);

// runtime-internal 是内部服务层：所有可信服务身份互调这一层。admin（网关）是信任超集，
// 也在此列，以便调运行时/未细分的模块路由（如 hub 未经 HUB-AUTHZ 拆分前的整片 /hub）。
// 真正的信任边界仍在：admin 等级（仅 admin caller）不被 runtime 凭据触达，
// web-bff 等级（仅 web-bff caller）与 runtime-internal 互不越界（web-bff 不在此列）。
const RUNTIME_INTERNAL_CALLERS: ServiceCaller[] = [
  "session",
  "agent",
  "credit",
  "payment",
  "model",
  "site",
  "user",
  "hub",
  "admin",
];

// 每个等级的允许调用方集合（public 不做 caller 校验，单列为 null）。
const LEVEL_ALLOWED_CALLERS: Record<AccessLevel, ReadonlySet<ServiceCaller> | null> = {
  public: null,
  "runtime-internal": new Set(RUNTIME_INTERNAL_CALLERS),
  "web-bff": new Set<ServiceCaller>(["web-bff"]),
  admin: new Set<ServiceCaller>(["admin"]),
};

// 路由匹配器：字符串=前缀匹配（path===matcher 或 path 以 `${matcher}/` 开头，避免 /administrators 误伤）；
// { path, exact:true }=精确匹配。多个匹配命中时取最长 path（最具体者胜），与声明顺序无关。
export type RouteMatcher = string | { path: string; exact?: boolean };

interface DeclaredRoute {
  path: string;
  exact: boolean;
  level: AccessLevel;
}

export interface RouteAccessConfig {
  // caller → secret 注册表（入站校验用）。缺省从 loadCallerSecrets(env) 得到；空=未配置。
  secrets: Partial<Record<ServiceCaller, string>>;
  // 生产模式：任一 requiredCallers 缺 secret → registerRouteAccess 同步抛错，进程启动失败。
  isProduction: boolean;
  // 本进程所需的 caller 凭据（入站要校验的 caller + 自身出站身份）。仅生产 fail-fast 用。
  requiredCallers?: ServiceCaller[];
  // 显式测试直通口：置真则跳过一切校验（等价旧 insecure local）。
  insecureLocal?: boolean;
  // dev 未配凭据时的一次性告警注入；缺省 console.warn。
  warn?: (message: string) => void;
  // 未声明路由的兜底等级（default-internal）。缺省 runtime-internal。
  defaultLevel?: AccessLevel;
}

interface RouteAccessState {
  routes: DeclaredRoute[];
  config: RouteAccessConfig;
  warned: boolean;
  anyConfigured: boolean;
  defaultLevel: AccessLevel;
}

const STATE = new WeakMap<FastifyInstance, RouteAccessState>();

// 从 env 读取每 caller 的 secret（KOKORO_INTERNAL_SECRET_<CALLER>，连字符转下划线）。
// 空串/缺失=该 caller 未配置（不进注册表）。
export function loadCallerSecrets(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<ServiceCaller, string>> {
  const out: Partial<Record<ServiceCaller, string>> = {};
  for (const caller of SERVICE_CALLERS) {
    const key = `KOKORO_INTERNAL_SECRET_${caller.toUpperCase().replace(/-/g, "_")}`;
    const value = env[key];
    if (value !== undefined && value.length > 0) {
      out[caller] = value;
    }
  }
  return out;
}

// 生产环境判定：NODE_ENV 或 KOKORO_ENV 为 production。
export function isProductionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production" || env.KOKORO_ENV === "production";
}

export class MissingCallerCredentialError extends Error {
  constructor(readonly callers: ServiceCaller[]) {
    super(
      `生产环境缺少内部调用方凭据：${callers
        .map((c) => `KOKORO_INTERNAL_SECRET_${c.toUpperCase().replace(/-/g, "_")}`)
        .join(", ")}`,
    );
    this.name = "MissingCallerCredentialError";
  }
}

function headerValue(request: FastifyRequest, key: string): string | undefined {
  const raw = request.headers[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

function normalizeMatcher(matcher: RouteMatcher, level: AccessLevel): DeclaredRoute {
  if (typeof matcher === "string") {
    return { path: matcher, exact: false, level };
  }
  return { path: matcher.path, exact: matcher.exact ?? false, level };
}

function matches(route: DeclaredRoute, path: string): boolean {
  if (route.exact) {
    return path === route.path;
  }
  return path === route.path || path.startsWith(`${route.path}/`);
}

// 解析请求路径的访问等级：命中的声明里取 path 最长者（最具体）；无命中 → defaultLevel。
function resolveLevel(routes: DeclaredRoute[], path: string, defaultLevel: AccessLevel): AccessLevel {
  let best: DeclaredRoute | undefined;
  for (const route of routes) {
    if (matches(route, path) && (best === undefined || route.path.length > best.path.length)) {
      best = route;
    }
  }
  return best?.level ?? defaultLevel;
}

// 安装入站访问控制钩子并初始化路由矩阵。生产缺凭据即抛（进程启动失败，杜绝空 secret 静默直通）。
// 校验顺序：public 直接放行 → insecureLocal 直通 → 未配凭据(dev)直通并告警一次 →
// 缺 caller 头 401 → 未知 caller/secret 不符 401（authn）→ caller 不在等级允许集 403（authz）。
export function registerRouteAccess(app: FastifyInstance, config: RouteAccessConfig): void {
  if (config.isProduction && !config.insecureLocal) {
    const required = config.requiredCallers ?? [];
    const missing = required.filter((caller) => {
      const secret = config.secrets[caller];
      return secret === undefined || secret.length === 0;
    });
    if (missing.length > 0) {
      throw new MissingCallerCredentialError(missing);
    }
  }

  const anyConfigured = Object.values(config.secrets).some((s) => s !== undefined && s.length > 0);
  const state: RouteAccessState = {
    routes: [],
    config,
    warned: false,
    anyConfigured,
    defaultLevel: config.defaultLevel ?? "runtime-internal",
  };
  STATE.set(app, state);

  const warn = config.warn ?? ((message: string) => console.warn(message));

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    const level = resolveLevel(state.routes, path, state.defaultLevel);

    if (level === "public") {
      return;
    }
    if (config.insecureLocal) {
      return;
    }
    if (!state.anyConfigured) {
      if (!config.isProduction) {
        if (!state.warned) {
          state.warned = true;
          warn(`[route-access] ${SERVICE_CALLER_HEADER}/${INTERNAL_SECRET_HEADER} 未配置，内部路由直通——仅限本地/过渡期，生产须配置`);
        }
        return;
      }
      return sendError(reply, 401, "internal.unauthorized", "内部调用凭据未配置");
    }

    const caller = headerValue(request, SERVICE_CALLER_HEADER);
    if (caller === undefined || caller.length === 0) {
      return sendError(reply, 401, "internal.unauthorized", "缺少调用方标识");
    }
    if (!CALLER_SET.has(caller)) {
      return sendError(reply, 401, "internal.unauthorized", "未知调用方");
    }
    const expected = state.config.secrets[caller as ServiceCaller];
    const provided = headerValue(request, INTERNAL_SECRET_HEADER);
    if (expected === undefined || provided !== expected) {
      return sendError(reply, 401, "internal.unauthorized", "调用方凭据无效");
    }
    const allowed = LEVEL_ALLOWED_CALLERS[level];
    if (allowed !== null && !allowed.has(caller as ServiceCaller)) {
      return sendError(reply, 403, "internal.forbidden", "调用方无权访问该访问等级");
    }
  });
}

// 声明一段路由的访问等级；须先 registerRouteAccess(app, ...)。matcher=前缀或 {path,exact}。
export function declareRouteAccess(app: FastifyInstance, matcher: RouteMatcher, level: AccessLevel): void {
  const state = STATE.get(app);
  if (state === undefined) {
    throw new Error("declareRouteAccess 须在 registerRouteAccess(app, ...) 之后调用");
  }
  state.routes.push(normalizeMatcher(matcher, level));
}
