import { describe, expect, it } from "vitest";

import { RESOURCE_FORMS, ROW_ACTION_FORMS } from "./resource-forms";

// 官方 MCP 注册 body 构造(纯函数):坐实与 hub registerMcpServerBodySchema 对齐。
describe("RESOURCE_FORMS hub:mcp-servers buildBody", () => {
  const form = RESOURCE_FORMS["hub:mcp-servers"]!;
  const ctx = { siteId: "" };

  it("scope 固定 official、allowedTools 逗号切数组去空、secretRef 空则省略", () => {
    expect(
      form.buildBody({ name: "github", transport: "http", url: "https://mcp.example/github", allowedTools: "a, b ,, c" }, ctx),
    ).toEqual({
      scope: "official",
      name: "github",
      transport: "http",
      url: "https://mcp.example/github",
      allowed_tools: ["a", "b", "c"],
    });
  });

  it("留空 allowedTools → 空数组(全放行);有 secretRef → 带上", () => {
    expect(
      form.buildBody({ name: "slack", transport: "streamable_http", url: "https://mcp.example/slack", allowedTools: "", secretRef: "env:SLACK_TOKEN" }, ctx),
    ).toEqual({
      scope: "official",
      name: "slack",
      transport: "streamable_http",
      url: "https://mcp.example/slack",
      allowed_tools: [],
      secret_ref: "env:SLACK_TOKEN",
    });
  });
});

// 行级 typed 小表单的 body 构造(纯函数):坐实与 hub 各动作 body schema 对齐。
describe("ROW_ACTION_FORMS buildBody", () => {
  it("official-flags: 恒发两布尔(后端 superRefine 至少一个满足);未触碰开关按 false", () => {
    const form = ROW_ACTION_FORMS["hub:skills:official-flags"]!;
    expect(form.buildBody({ official_enabled: true, official_required: false })).toEqual({
      enabled: true,
      required: false,
    });
    expect(form.buildBody({})).toEqual({ enabled: false, required: false });
  });

  it("curation: 权重转数字、空 category 转 null(清除)、缺省不发权重", () => {
    const form = ROW_ACTION_FORMS["hub:skill-curation:curation"]!;
    expect(form.buildBody({ pinned: true, display_weight: "5", category: "docs" })).toEqual({
      pinned: true,
      display_weight: 5,
      category: "docs",
    });
    // 缺 display_weight → 不发;空 category → null;pinned 缺省 false。
    expect(form.buildBody({ category: "" })).toEqual({ pinned: false, category: null });
  });

  it("review: 单选 review_status → { status }", () => {
    const form = ROW_ACTION_FORMS["hub:skill-curation:review"]!;
    expect(form.buildBody({ review_status: "rejected" })).toEqual({ status: "rejected" });
  });

  it("credit grant: 整数积分 → micros(×10000)、owner 由行预填透传", () => {
    const form = ROW_ACTION_FORMS["credit:credit-accounts:grant"]!;
    expect(form.buildBody({ ownerKind: "team", ownerId: "t1", amountCredits: "100", reason: "manual_adjustment" })).toEqual({
      ownerKind: "team",
      ownerId: "t1",
      amountMicros: "1000000",
      reason: "manual_adjustment",
    });
  });

  it("credit reset: 目标积分 → targetMicros(可清零)、reason 缺省 manual_adjustment", () => {
    const form = ROW_ACTION_FORMS["credit:credit-accounts:reset"]!;
    expect(form.buildBody({ ownerKind: "user", ownerId: "u1", targetCredits: "0" })).toEqual({
      ownerKind: "user",
      ownerId: "u1",
      targetMicros: "0",
      reason: "manual_adjustment",
    });
  });

  it("credit set-quota: 填积分 → quotaMicros(×10000)+monthly；留空 → null 清除", () => {
    const form = ROW_ACTION_FORMS["credit:credit-accounts:set-quota"]!;
    expect(form.buildBody({ quotaCredits: "5000" })).toEqual({ quotaMicros: "50000000", quotaPeriod: "monthly" });
    expect(form.buildBody({})).toEqual({ quotaMicros: null, quotaPeriod: "monthly" });
  });

  it("pricing update: 单价/状态直透，缺省字段省略（部分更新）", () => {
    const form = ROW_ACTION_FORMS["credit:pricing-rules:update"]!;
    expect(form.buildBody({ amountMicros: "480", status: "disabled" })).toEqual({ amountMicros: "480", status: "disabled" });
    expect(form.buildBody({ amountMicros: "40" })).toEqual({ amountMicros: "40" });
  });
});

describe("RESOURCE_FORMS credit:pricing-rules buildBody", () => {
  const form = RESOURCE_FORMS["credit:pricing-rules"]!;
  const ctx = { siteId: "" };

  it("createOnly + 必填直透，labelKey/status 缺省省略", () => {
    expect(form.createOnly).toBe(true);
    expect(form.buildBody({ featureKey: "chat.input_token", unit: "token", amountMicros: "40" }, ctx)).toEqual({
      featureKey: "chat.input_token",
      unit: "token",
      amountMicros: "40",
    });
  });

  it("带 labelKey/status 时并入", () => {
    expect(
      form.buildBody({ featureKey: "chat.output_token", labelKey: "claude-code", unit: "token", amountMicros: "120", status: "active" }, ctx),
    ).toEqual({
      featureKey: "chat.output_token",
      labelKey: "claude-code",
      unit: "token",
      amountMicros: "120",
      status: "active",
    });
  });
});
