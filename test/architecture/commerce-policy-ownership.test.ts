import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

describe("Commerce policy ownership", () => {
  it("keeps command policies in the Commerce application boundary", () => {
    for (const policy of ["command-authorization.ts", "command-lock-order.ts"]) {
      expect(
        existsSync(join(sourceRoot, "modules", "commerce", "application", policy)),
        policy,
      ).toBe(true);
    }
  });

  it("removes the single-owner Commerce workflow tree", () => {
    expect(existsSync(join(sourceRoot, "workflows", "commerce"))).toBe(false);
    expect(existsSync(join(sourceRoot, "workflows"))).toBe(false);
  });

  it("does not mount an Unimplemented AdminCommerce placeholder in production", () => {
    const placeholder = join(
      sourceRoot,
      "modules",
      "commerce",
      "interfaces",
      "connect",
      "admin-commerce-service.ts",
    );
    const composition = readFileSync(join(sourceRoot, "process", "admin-composition.ts"), "utf8");

    expect(existsSync(placeholder)).toBe(false);
    expect(composition).not.toContain("generated/proto/kokoro/platform/commerce/v1/admin_commerce_pb.js");
    expect(composition).not.toContain("admin-commerce-service.js");
    expect(composition).not.toContain("createAdminCommerceConnectService");
    expect(composition).not.toContain("router.service(AdminCommerceService");
  });

  it("reserves orchestration for journeys spanning multiple bounded contexts", () => {
    const orchestrationRoot = join(sourceRoot, "orchestration");
    const violations: string[] = [];
    if (existsSync(orchestrationRoot)) {
      for (const file of typeScriptFiles(orchestrationRoot)) {
        const source = readFileSync(file, "utf8");
        const owners = new Set(
          [...source.matchAll(/from\s+["'][^"']*modules\/([^/"']+)/gu)]
            .map((match) => match[1])
            .filter((owner): owner is string => owner !== undefined),
        );
        if (owners.size < 2) {
          violations.push(
            `${relative(sourceRoot, file)} imports only ${[...owners].join(", ") || "no module owners"}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

function typeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...typeScriptFiles(path));
    else if (extname(path) === ".ts") files.push(path);
  }
  return files;
}
