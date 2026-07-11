import { describe, expect, it } from "vitest";
import { SkillHubService } from "../../src/application/skill-hub-service.js";
import { SkillRequiredError } from "../../src/domain/errors.js";
import { FakeSkillRepository } from "../doubles/fake-skill-repository.js";

function makeService(repo = new FakeSkillRepository()) {
  return { repo, service: new SkillHubService(repo, { maxPackages: 100, maxBytes: 2048 }) };
}

describe("SkillHubService", () => {
  it("composes the quota view from usage plus env limits", async () => {
    const { repo, service } = makeService();
    repo.usage = { packageCount: 3, packageBytes: 512 };

    expect(await service.quota("ns-1")).toEqual({
      namespace: "ns-1",
      package_count: 3,
      package_bytes: 512,
      max_packages: 100,
      max_bytes: 2048,
    });
  });

  it("delegates pool listing to the repository", async () => {
    const { repo, service } = makeService();
    repo.pool = [{ name: "a", description: "d", content_hash: "h", scope: "official" }];

    expect(await service.listPool("ns-1")).toEqual(repo.pool);
  });

  it("records enable/disable, official flags and soft delete on the repository", async () => {
    const { repo, service } = makeService();

    await service.setEnabled("ns-1", "writer", true);
    await service.setOfficialFlags("writer", { required: true });
    await service.markDeleted("ns-1", "writer");

    expect(repo.enabledCalls).toEqual([{ namespace: "ns-1", name: "writer", enabled: true }]);
    expect(repo.officialCalls).toEqual([{ name: "writer", flags: { required: true } }]);
    expect(repo.deletedCalls).toEqual([{ scope: "ns-1", name: "writer" }]);
  });

  it("propagates SkillRequiredError when disabling a required skill", async () => {
    const { repo, service } = makeService();
    repo.requiredNames.add("guardrails");

    await expect(service.setEnabled("ns-1", "guardrails", false)).rejects.toBeInstanceOf(
      SkillRequiredError,
    );
  });
});
