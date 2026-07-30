import type { CapabilityCatalogSnapshot } from "../../domain/capability-catalog.js";
import type { CapabilityCatalogAuthority } from "../../domain/capability-publication-repository.js";
import type { HubCollections } from "./mongo-client.js";

/** Validates the mutable Hub sources before they are sealed into an immutable release catalog. */
export class MongoCapabilityCatalogAuthority implements CapabilityCatalogAuthority {
  constructor(private readonly collections: HubCollections) {}

  async assertCurrent(snapshot: CapabilityCatalogSnapshot): Promise<void> {
    await Promise.all([
      ...snapshot.skillOptions.map(async (item) => {
        const row = await this.collections.skills.findOne(
          { scope: item.scope, name: item.name, deleted_at: null },
          { projection: {
            content_hash: 1,
            description: 1,
            review_status: 1,
            official_enabled: 1,
            official_required: 1,
          } },
        );
        if (row === null || row.content_hash !== item.contentHash || row.description !== item.description ||
            (row.review_status !== undefined && row.review_status !== "approved") ||
            (item.scope === "official" && row.official_enabled !== true && row.official_required !== true)) {
          throw new Error("HUB_CAPABILITY_CATALOG_SKILL_NOT_CURRENT");
        }
      }),
      ...snapshot.mcpOptions.map(async (item) => {
        const [revision, live] = await Promise.all([
          this.collections.mcpServerRevisions.findOne({
            scope: item.scope,
            name: item.name,
            revision: item.revision,
          }),
          this.collections.mcpServers.findOne({ scope: item.scope, name: item.name }),
        ]);
        if (revision === null || revision.config_hash !== item.configHash || live === null ||
            live.revision !== item.revision || live.enabled !== true || live.deleted_at !== null) {
          throw new Error("HUB_CAPABILITY_CATALOG_MCP_NOT_CURRENT");
        }
      }),
    ]);
  }
}
