import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const path = "src/modules/site/interfaces/connect/site-evidence-admission-service.ts";
const ownerPath =
  "src/modules/site/application/services/site-release-evidence-authority-service.ts";

describe("Site Evidence Connect boundary", () => {
  it("validates the complete Root request before mTLS/live resolution and uses the verified Root digest", async () => {
    const source = await readFile(path, "utf8");
    expect(source).toContain('import { createValidator } from "@bufbuild/protovalidate"');
    expect(source).toContain("RecordReleaseEvidenceRequestSchema");
    const validate = source.indexOf(
      "createValidator().validate(RecordReleaseEvidenceRequestSchema, request)",
    );
    const resolve = source.indexOf("input.resolver.resolve(");
    const digest = source.indexOf("recordReleaseEvidenceRequestDigest(");
    const owner = source.indexOf("input.owner.recordEvidence(");
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(resolve);
    expect(resolve).toBeLessThan(digest);
    expect(digest).toBeLessThan(owner);
    expect(source).toContain("requestDigest: verifiedRequestDigest");
    expect(source).toContain("workload: verified.workload");
    expect(source).toContain("ControlCommandReceiptTimestampReader");
    const receipt = source.indexOf("input.receipts.read(");
    expect(receipt).toBeGreaterThan(owner);
    expect(source).not.toContain("canonicalDate(result.recordedAt)");
  });

  it("keeps command receipt time out of the evidence owner result", async () => {
    const source = await readFile(ownerPath, "utf8");
    expect(source).not.toContain("recordedAt: verified.verifiedAt");
    expect(source).not.toContain("recordedAt: replay.recordedAt");
  });
});
