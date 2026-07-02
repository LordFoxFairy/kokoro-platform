import type { JsonObject } from "./json.js";
import type { DeletionAudit } from "./site-deletion.js";

export interface SiteFeatureFlag extends DeletionAudit {
  id: string;
  siteId: string;
  key: string;
  enabled: boolean;
  metadata: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
}
