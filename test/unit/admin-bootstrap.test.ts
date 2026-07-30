import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadBootstrapDocument } from
  "../../src/process/admin-authority-bootstrap.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Admin authority offline bootstrap", () => {
  it("accepts a private absolute two-governor document and freezes its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-admin-bootstrap-"));
    directories.push(directory);
    const path = join(directory, "bootstrap.json");
    await writeFile(path, JSON.stringify({ version: 1, authorities: [authority("maker"), authority("checker")] }));
    await chmod(path, 0o600);

    await expect(loadBootstrapDocument(path)).resolves.toMatchObject({
      authorities: [{ operatorRef: "maker" }, { operatorRef: "checker" }],
      configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects group-readable bootstrap material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-admin-bootstrap-"));
    directories.push(directory);
    const path = join(directory, "bootstrap.json");
    await writeFile(path, JSON.stringify({ version: 1, authorities: [authority("maker"), authority("checker")] }));
    await chmod(path, 0o640);
    await expect(loadBootstrapDocument(path)).rejects.toThrow("ADMIN_BOOTSTRAP_FILE_UNSAFE");
  });

  it.each([
    ["unknown authority field", { unexpected: true }],
    ["invalid permission", { permissions: ["admin.approval.execute", "admin.authority.manage", "bad\npermission"] }],
    ["invalid nested Site scope", { siteScopes: [{ ...authority("maker").siteScopes[0], siteRef: "*" }] }],
    ["invalid global grant", { globalScopes: [{ ...authority("maker").globalScopes[0], grantRef: "not-a-uuid" }] }],
    ["invalid identity issuer", { identities: [{ ...authority("maker").identities[0], issuer: "http://issuer.example.test" }] }],
  ])("rejects %s before opening the database", async (_label, change) => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-admin-bootstrap-"));
    directories.push(directory);
    const path = join(directory, "bootstrap.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      authorities: [{ ...authority("maker"), ...change }, authority("checker")],
    }));
    await chmod(path, 0o600);

    await expect(loadBootstrapDocument(path)).rejects.toThrow("ADMIN_BOOTSTRAP_DOCUMENT_INVALID");
  });

  it("rejects duplicate identities and grant references across governors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-admin-bootstrap-"));
    directories.push(directory);
    const path = join(directory, "bootstrap.json");
    const maker = authority("maker");
    const checker = authority("checker");
    await writeFile(path, JSON.stringify({
      version: 1,
      authorities: [maker, {
        ...checker,
        globalScopes: maker.globalScopes,
        identities: maker.identities,
      }],
    }));
    await chmod(path, 0o600);

    await expect(loadBootstrapDocument(path)).rejects.toThrow("ADMIN_BOOTSTRAP_DOCUMENT_INVALID");
  });
});

function authority(operatorRef: string) {
  const maker = operatorRef === "maker";
  return {
    operatorRef, operatorGeneration: "1",
    permissions: ["admin.approval.execute", "admin.authority.manage"],
    operatorSecurityEpoch: "1", authorizationEpoch: "1",
    expiresAt: "2027-07-29T00:00:00.000Z",
    siteScopes: [{
      siteRef: maker ? "site:maker" : "site:checker",
      environment: "production", region: "us-east-1", scopeEpoch: "1",
      expiresAt: "2027-07-29T00:00:00.000Z",
    }],
    globalScopes: [{
      grantRef: maker
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      environment: "production", region: "us-east-1", scopeEpoch: "1",
      expiresAt: "2027-07-29T00:00:00.000Z",
    }],
    identities: [{
      identityRef: maker
        ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      issuer: "https://issuer.example.test", subject: `subject:${operatorRef}`,
    }],
  };
}
