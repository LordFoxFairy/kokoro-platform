// 资源新建/编辑表单注册表：manifest 只声明动作不带字段 schema，字段在此按 (moduleId:resourceId) 定义。
// 提交走 /api/action（upsert/create 动作 + body），享网关 RBAC + 审批 + 审计。
// optionsFrom：字段值是「另一资源的行 id」时，前端拉该资源列表做下拉（免运营填裸 cuid）。

export interface OptionsFrom {
  moduleId: string;
  resourceId: string;
  labelKeys: string[]; // 拼成下拉显示文案
  siteScoped?: boolean; // 是否按当前 siteId 过滤
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "switch" | "json";
  required?: boolean;
  options?: { label: string; value: string }[];
  optionsFrom?: OptionsFrom;
  placeholder?: string;
  editable?: boolean;
  tip?: string;
}

export interface ResourceForm {
  actionId: string;
  createLabel: string;
  keyField: string;
  fields: FormField[];
  buildBody: (values: Record<string, unknown>, ctx: { siteId: string }) => Record<string, unknown>;
}

const SITE_STATUS = [
  { label: "草稿 draft", value: "draft" },
  { label: "沙箱 sandbox", value: "sandbox" },
  { label: "灰度 beta", value: "beta" },
  { label: "上线 active", value: "active" },
  { label: "暂停 suspended", value: "suspended" },
  { label: "归档 archived", value: "archived" },
];
const ONOFF = [
  { label: "启用 active", value: "active" },
  { label: "停用 disabled", value: "disabled" },
];
const BILLING = [
  { label: "一次性 once", value: "once" },
  { label: "按月 month", value: "month" },
  { label: "按年 year", value: "year" },
];
const TRANSPORT = [
  { label: "litellm", value: "litellm" },
  { label: "direct", value: "direct" },
  { label: "internal", value: "internal" },
];

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
function has(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}
function safeJson(v: unknown): Record<string, unknown> {
  if (typeof v === "object" && v !== null) return v as Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(str(v) || "{}");
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const USERS_SRC: OptionsFrom = { moduleId: "user", resourceId: "users", labelKeys: ["displayName", "email", "id"], siteScoped: true };
const PROVIDERS_SRC: OptionsFrom = { moduleId: "model", resourceId: "provider-accounts", labelKeys: ["label", "provider", "id"] };

export const RESOURCE_FORMS: Record<string, ResourceForm> = {
  // ── L1 租户 ──
  "site:sites": {
    actionId: "upsert",
    createLabel: "新建站点",
    keyField: "key",
    fields: [
      { name: "key", label: "站点标识 (key)", type: "text", required: true, placeholder: "如 acme（siteId=site-<key>，编辑不可改）", editable: false },
      { name: "name", label: "站点名称", type: "text", required: true },
      { name: "status", label: "状态", type: "select", options: SITE_STATUS },
      { name: "defaultLocale", label: "默认语言", type: "text", placeholder: "zh-CN" },
      { name: "timezone", label: "时区", type: "text", placeholder: "Asia/Shanghai" },
    ],
    buildBody: (v) => {
      const b: Record<string, unknown> = { key: str(v.key), name: str(v.name) };
      if (has(v.status)) b.status = str(v.status);
      if (has(v.defaultLocale)) b.defaultLocale = str(v.defaultLocale);
      if (has(v.timezone)) b.timezone = str(v.timezone);
      return b;
    },
  },
  "site:domains": {
    actionId: "bind",
    createLabel: "新建域名",
    keyField: "host",
    fields: [
      { name: "host", label: "域名 host", type: "text", required: true, placeholder: "如 acme.example.com", editable: false },
      { name: "status", label: "状态", type: "select", options: [{ label: "生效 active", value: "active" }, { label: "停用 disabled", value: "disabled" }, { label: "待验证 pending_verification", value: "pending_verification" }] },
      { name: "isPrimary", label: "设为主域名", type: "switch" },
      { name: "canonicalHost", label: "规范域名", type: "text" },
    ],
    buildBody: (v, ctx) => {
      const b: Record<string, unknown> = { siteId: ctx.siteId, host: str(v.host) };
      if (has(v.status)) b.status = str(v.status);
      if (v.isPrimary !== undefined) b.isPrimary = Boolean(v.isPrimary);
      if (has(v.canonicalHost)) b.canonicalHost = str(v.canonicalHost);
      return b;
    },
  },
  "site:apps": {
    actionId: "configure",
    createLabel: "新建应用",
    keyField: "appKey",
    fields: [
      { name: "appKey", label: "应用键 (appKey)", type: "text", required: true, editable: false },
      { name: "surface", label: "载体 surface", type: "text", required: true, placeholder: "如 web / admin / api" },
      { name: "status", label: "状态", type: "select", options: ONOFF },
      { name: "defaultRoute", label: "默认路由", type: "text", placeholder: "/" },
    ],
    buildBody: (v, ctx) => {
      const b: Record<string, unknown> = { siteId: ctx.siteId, appKey: str(v.appKey), surface: str(v.surface) };
      if (has(v.status)) b.status = str(v.status);
      if (has(v.defaultRoute)) b.defaultRoute = str(v.defaultRoute);
      return b;
    },
  },
  "site:policies": {
    actionId: "set",
    createLabel: "新建策略",
    keyField: "key",
    fields: [
      { name: "key", label: "策略键 (key)", type: "text", required: true, editable: false },
      { name: "value", label: "策略值 (JSON)", type: "json", required: true, placeholder: '{"maxSeats": 10}' },
      { name: "status", label: "状态", type: "select", options: ONOFF },
    ],
    buildBody: (v, ctx) => {
      const b: Record<string, unknown> = { siteId: ctx.siteId, key: str(v.key), value: safeJson(v.value) };
      if (has(v.status)) b.status = str(v.status);
      return b;
    },
  },
  "site:feature-flags": {
    actionId: "toggle",
    createLabel: "新建功能开关",
    keyField: "key",
    fields: [
      { name: "key", label: "开关键 (key)", type: "text", required: true, editable: false },
      { name: "enabled", label: "开启", type: "switch" },
    ],
    buildBody: (v, ctx) => ({ siteId: ctx.siteId, key: str(v.key), enabled: Boolean(v.enabled) }),
  },

  // ── L2/L3 供给·变现 ──
  "payment:plans": {
    actionId: "upsert",
    createLabel: "新建套餐",
    keyField: "key",
    fields: [
      { name: "key", label: "套餐标识 (key)", type: "text", required: true, placeholder: "如 pro-monthly", editable: false },
      { name: "name", label: "套餐名称", type: "text", required: true },
      { name: "currency", label: "币种 (3 位)", type: "text", required: true, placeholder: "CNY / USD" },
      { name: "amountMinor", label: "金额 (分)", type: "number", required: true, tip: "最小货币单位，9900=99.00" },
      { name: "creditMicros", label: "赠送积分 (micros)", type: "number", tip: "1e6=1 积分；>0 才到账" },
      { name: "billingInterval", label: "计费周期", type: "select", required: true, options: BILLING },
    ],
    buildBody: (v) => {
      const b: Record<string, unknown> = {
        key: str(v.key),
        name: str(v.name),
        currency: str(v.currency).toUpperCase(),
        amountMinor: str(v.amountMinor),
        billingInterval: str(v.billingInterval),
      };
      if (has(v.creditMicros)) b.creditMicros = str(v.creditMicros);
      return b;
    },
  },

  // ── L5 用户/团队 ──
  "user:users": {
    actionId: "create",
    createLabel: "新建用户",
    keyField: "externalUserId",
    fields: [
      { name: "externalUserId", label: "外部用户 id", type: "text", required: true, placeholder: "外部系统的用户标识", editable: false },
      { name: "email", label: "邮箱", type: "text" },
      { name: "displayName", label: "昵称", type: "text" },
    ],
    buildBody: (v) => {
      const b: Record<string, unknown> = { externalUserId: str(v.externalUserId) };
      if (has(v.email)) b.email = str(v.email);
      if (has(v.displayName)) b.displayName = str(v.displayName);
      return b;
    },
  },
  "user:teams": {
    actionId: "create",
    createLabel: "新建团队",
    keyField: "slug",
    fields: [
      { name: "slug", label: "团队标识 (slug)", type: "text", required: true, placeholder: "站内唯一", editable: false },
      { name: "name", label: "团队名称", type: "text", required: true },
      { name: "ownerUserId", label: "所有者", type: "select", required: true, optionsFrom: USERS_SRC },
    ],
    buildBody: (v) => ({ slug: str(v.slug), name: str(v.name), ownerUserId: str(v.ownerUserId) }),
  },

  // ── L6 模型 ──
  "model:provider-accounts": {
    actionId: "create",
    createLabel: "新建供应商账号",
    keyField: "key",
    fields: [
      { name: "provider", label: "供应商", type: "text", required: true, placeholder: "openai / anthropic" },
      { name: "key", label: "账号标识 (key)", type: "text", required: true, editable: false },
      { name: "label", label: "显示名", type: "text", required: true },
      { name: "secretRef", label: "密钥引用", type: "text", required: true, placeholder: "密钥管理引用键，非明文" },
      { name: "transportKind", label: "传输方式", type: "select", required: true, options: TRANSPORT },
      { name: "priority", label: "优先级", type: "number" },
    ],
    buildBody: (v) => {
      const b: Record<string, unknown> = {
        provider: str(v.provider),
        key: str(v.key),
        label: str(v.label),
        secretRef: str(v.secretRef),
        transportKind: str(v.transportKind),
      };
      if (has(v.priority)) b.priority = Number(v.priority);
      return b;
    },
  },
  "model:model-bindings": {
    actionId: "create",
    createLabel: "新建模型绑定",
    keyField: "modelName",
    fields: [
      { name: "providerAccountId", label: "供应商账号", type: "select", required: true, optionsFrom: PROVIDERS_SRC },
      { name: "modelName", label: "模型名", type: "text", required: true, placeholder: "gpt-4o" },
      { name: "displayName", label: "显示名", type: "text", required: true },
      { name: "featureKey", label: "能力键", type: "text", required: true, placeholder: "chat / embedding" },
      { name: "transportKind", label: "传输方式", type: "select", required: true, options: TRANSPORT },
      { name: "gatewayModelName", label: "网关模型名", type: "text", tip: "transportKind=litellm 时必填" },
      { name: "contextWindow", label: "上下文窗口", type: "number" },
    ],
    buildBody: (v) => {
      const b: Record<string, unknown> = {
        providerAccountId: str(v.providerAccountId),
        modelName: str(v.modelName),
        displayName: str(v.displayName),
        featureKey: str(v.featureKey),
        transportKind: str(v.transportKind),
      };
      if (has(v.gatewayModelName)) b.gatewayModelName = str(v.gatewayModelName);
      if (has(v.contextWindow)) b.contextWindow = Number(v.contextWindow);
      return b;
    },
  },
  "model:site-policies": {
    actionId: "set",
    createLabel: "设置站点模型策略",
    keyField: "labelKey",
    fields: [
      { name: "labelKey", label: "模型标签键", type: "text", required: true, editable: false },
      { name: "status", label: "可见性", type: "select", required: true, options: [{ label: "可见 visible", value: "visible" }, { label: "隐藏 hidden", value: "hidden" }] },
    ],
    buildBody: (v, ctx) => ({ siteId: ctx.siteId, labelKey: str(v.labelKey), status: str(v.status) }),
  },
  // ── HUB 官方 MCP server 注册（运营写官方目录）──
  // 凭据只收 env:/secret: 引用(明文由 hub 拒收);allowed_tools 逗号分隔 → 数组;scope 固定 official。
  "hub:mcp-servers": {
    actionId: "register",
    createLabel: "注册官方 MCP server",
    keyField: "name",
    fields: [
      { name: "name", label: "server 名", type: "text", required: true, editable: false, placeholder: "小写字母/连字符，如 github", tip: "2-64 位，小写字母开头，仅 a-z 0-9 -" },
      { name: "transport", label: "传输方式", type: "select", required: true, options: [{ label: "http", value: "http" }, { label: "streamable_http", value: "streamable_http" }] },
      { name: "url", label: "端点 URL", type: "text", required: true, placeholder: "https://mcp.example/github" },
      { name: "allowedTools", label: "放行工具（逗号分隔，留空=全放行）", type: "text", placeholder: "search_issues, create_issue" },
      { name: "secretRef", label: "凭据引用", type: "text", placeholder: "env:GH_MCP_TOKEN 或 secret:path/to/key", tip: "只收 env:/secret: 引用，明文凭据会被拒收" },
    ],
    buildBody: (v) => {
      const tools = str(v.allowedTools)
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const b: Record<string, unknown> = {
        scope: "official",
        name: str(v.name),
        transport: str(v.transport),
        url: str(v.url),
        allowed_tools: tools,
      };
      if (has(v.secretRef)) b.secret_ref = str(v.secretRef);
      return b;
    },
  },
};

// —— 行级 typed 小表单（ROW_ACTION_FORMS）：manifest 里非 SIMPLE_ACTIONS、需 typed body 的「行级动作」
// 在此声明字段。点行内动作即开小表单(初值由行当前值预填),提交发
// { params: { [firstRouteParam]: row.id }, body: buildBody(values) }，享网关 RBAC/审批/审计。
// 键 = `${moduleId}:${resourceId}:${actionId}`。
export interface RowActionForm {
  fields: FormField[];
  buildBody: (values: Record<string, unknown>) => Record<string, unknown>;
}

const REVIEW_STATUS = [
  { label: "待审 pending", value: "pending" },
  { label: "通过 approved", value: "approved" },
  { label: "拒绝 rejected", value: "rejected" },
];

export const ROW_ACTION_FORMS: Record<string, RowActionForm> = {
  // 官方位:上架开关 + 必备位（恒发两布尔,后端 superRefine「至少一个」满足;字段名对齐目录行,初值预填）。
  "hub:skills:official-flags": {
    fields: [
      { name: "official_enabled", label: "上架 official_enabled", type: "switch", tip: "全局上架开关" },
      { name: "official_required", label: "必备 official_required", type: "switch", tip: "恒注入,拒绝用户关闭" },
    ],
    buildBody: (v) => ({ enabled: Boolean(v.official_enabled), required: Boolean(v.official_required) }),
  },
  // 运营位:置顶/权重/分类（留空 category = 清除分类）。
  "hub:skill-curation:curation": {
    fields: [
      { name: "pinned", label: "置顶 pinned", type: "switch" },
      { name: "display_weight", label: "排序权重 display_weight", type: "number" },
      { name: "category", label: "分类 category", type: "text", placeholder: "留空 = 清除分类" },
    ],
    buildBody: (v) => {
      const body: Record<string, unknown> = { pinned: Boolean(v.pinned) };
      if (has(v.display_weight)) body.display_weight = Number(v.display_weight);
      body.category = str(v.category) === "" ? null : str(v.category);
      return body;
    },
  },
  // 审核态:单选（字段名 review_status 对齐目录行,初值预填;body 映射为 status）。
  "hub:skill-curation:review": {
    fields: [{ name: "review_status", label: "审核态", type: "select", required: true, options: REVIEW_STATUS }],
    buildBody: (v) => ({ status: str(v.review_status) }),
  },
};
