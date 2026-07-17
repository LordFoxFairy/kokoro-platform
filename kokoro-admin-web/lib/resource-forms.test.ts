import { describe, expect, it } from "vitest";

import { ROW_ACTION_FORMS } from "./resource-forms";

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
});
