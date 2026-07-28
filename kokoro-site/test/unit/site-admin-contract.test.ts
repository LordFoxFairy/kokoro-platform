import { describe, expect, it } from "vitest";
import { siteAdminContract } from "../../src/interfaces/admin/site-admin-contract.js";
import { siteAdminManifest } from "../../src/interfaces/admin/manifest.js";

describe("siteAdminContract", () => {
  it("is the source for the exported site admin manifest", () => {
    expect(siteAdminManifest).toEqual(siteAdminContract.manifest);
  });

  it("declares standard delete and restore actions for sites and domains", () => {
    const sites = siteAdminContract.manifest.resources.find((resource) => resource.id === "sites");
    const domains = siteAdminContract.manifest.resources.find((resource) => resource.id === "domains");

    expect(sites?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "delete",
          kind: "dangerMutation",
          method: "DELETE",
          route: "/sites/:siteId",
          requiredPermission: "site.delete",
        }),
        expect.objectContaining({
          id: "restore",
          kind: "mutation",
          method: "POST",
          route: "/sites/:siteId/restore",
          requiredPermission: "site.restore",
        }),
      ]),
    );
    expect(domains?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "delete",
          kind: "dangerMutation",
          method: "DELETE",
          route: "/site-domains/:domainId",
          requiredPermission: "siteDomain.delete",
        }),
        expect.objectContaining({
          id: "restore",
          kind: "mutation",
          method: "POST",
          route: "/site-domains/:domainId/restore",
          requiredPermission: "siteDomain.restore",
        }),
      ]),
    );
  });

  it("uses the Site row id for sites and siteId for child resources", () => {
    expect(Object.fromEntries(siteAdminContract.manifest.resources.map((resource) => [resource.id, resource.siteScopeField]))).toEqual({
      sites: "id",
      domains: "siteId",
      apps: "siteId",
      policies: "siteId",
      "feature-flags": "siteId",
    });
  });
});
