import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Platform runtime contract ownership", () => {
  it("makes Admission consume the canonical generated control contract", async () => {
    const [contract, draftFactory, admissionAuthority, hubServer] = await Promise.all([
      readFile(resolve("src/generated/contracts/runtime/platform-control.ts"), "utf8"),
      readFile(resolve("src/modules/admission/application/ga-run-request-draft-factory.ts"), "utf8"),
      readFile(resolve("src/modules/admission/application/platform-admission-owner-authority.ts"), "utf8"),
      readFile(resolve("kokoro-hub/src/interfaces/http/server.ts"), "utf8"),
    ]);
    const retiredMirrorRoot = ["generated", "contracts", "legacy"].join("/");
    expect(contract).toContain("executionContextIntentSchema");
    expect(draftFactory).toContain("generated/contracts/runtime/platform-control");
    expect(admissionAuthority).toContain("generated/contracts/runtime/platform-control");
    expect(draftFactory).not.toContain(retiredMirrorRoot);
    expect(admissionAuthority).not.toContain(retiredMirrorRoot);
    expect(hubServer).toContain("@kokoro/platform-kit");
    expect(draftFactory).not.toMatch(/export const executionContextIntentSchema\s*=\s*z/u);
  });

  it("publishes only root Platform processes and Hub through the image selector", async () => {
    const entrypoint = await readFile(resolve("deploy/docker/runtime-entrypoint.mjs"), "utf8");
    for (const selector of [
      "platform-api",
      "platform-admission",
      "platform-authorization",
      "platform-asset-data-plane",
      "platform-model-gateway",
      "platform-admin",
      "platform-commerce-worker",
      "platform-site-worker",
      "platform-asset-worker",
      "platform-admin-worker",
      "platform-identity-worker",
      "platform-authorization-maintenance",
      "platform-migrator",
      "@kokoro/hub",
      "platform-hub-connect",
    ]) expect(entrypoint).toContain(`"${selector}"`);
    expect(entrypoint).not.toMatch(/@kokoro\/(?:site|user|model|credit|payment|platform-admin)/u);
  });
});
