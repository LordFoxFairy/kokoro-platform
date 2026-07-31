import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Media typed usage owner migration", () => {
  it("uses a candidate semi-join so one invocation with four outputs returns one usage fact", () => {
    const sql = readFileSync(new URL(
      "../../prisma/migrations/20260811_media_image_typed_usage_materializer/migration.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("AND EXISTS(");
    expect(sql).toContain("FROM platform.media_candidate candidate");
    expect(sql).not.toMatch(/JOIN platform\.media_candidate candidate\s+ON/u);
    expect(sql).not.toContain("SELECT DISTINCT");
  });

  it("binds one strict usage fact to the terminal attempt before journaling", () => {
    const sql = readFileSync(new URL(
      "../../prisma/migrations/20260810_model_image_effect_vertical/migration.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("usage_count INTEGER");
    expect(sql).toContain("requested_kind='succeeded' AND usage_count<>1");
    expect(sql).toContain("requested_kind='outcome_unknown' AND usage_count<>0");
    expect(sql).toContain("requested_attempt->>'usageEvidenceRef'=evidence.value->>'evidenceRef'");
    expect(sql).toContain("COALESCE(evidence.value#>>'{usageFact,evidenceKind}','') NOT IN");
    expect(sql).toContain("jsonb_array_length(evidence.value#>'{usageFact,dimensions}')>64");
  });
});
