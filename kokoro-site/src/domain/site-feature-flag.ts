import type { JsonObject } from "./json.js";

export interface SiteFeatureFlag {
  id: string;
  siteId: string;
  key: string;
  enabled: boolean;
  metadata: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
}
