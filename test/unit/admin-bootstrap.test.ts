import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadBootstrapDocument } from
  "../../scripts/admin-control/bootstrap-authority.mjs";

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
});

function authority(operatorRef: string) {
  return {
    operatorRef, operatorGeneration: "1",
    permissions: ["admin.approval.execute", "admin.authority.manage"],
    siteScopes: ["*"], environments: ["production"], regions: ["us-east-1"],
    authorizationEpoch: "1", expiresAt: "2027-07-29T00:00:00.000Z",
    breakGlassExpiresAt: null,
  };
}
