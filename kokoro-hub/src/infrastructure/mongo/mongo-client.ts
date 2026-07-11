import { type Collection, type Db, MongoClient } from "mongodb";
import { SKILL_STATE_COLLECTION, SKILLS_COLLECTION } from "../../contract/storage.js";

// Mongo 存储态记录（hub 写、agent 读，同库读写分离）。deleted_at 显式可空：
// upsert 时写 null，软删时写毫秒时间戳；查询 { deleted_at: null } 同时命中 null 与缺省。
export interface SkillRecord {
  scope: string;
  name: string;
  description: string;
  skill_md: string;
  files_manifest: { path: string; size: number }[];
  file_count: number;
  package_size: number;
  content_hash: string;
  package_ref: string;
  source: string;
  revision: number;
  official_enabled: boolean;
  official_required: boolean;
  updated_at: number;
  deleted_at: number | null;
}

export interface SkillStateRecord {
  namespace: string;
  name: string;
  enabled: boolean;
  updated_at: number;
}

export interface HubCollections {
  skills: Collection<SkillRecord>;
  state: Collection<SkillStateRecord>;
}

export function createMongoClient(url: string): MongoClient {
  return new MongoClient(url);
}

export function hubCollections(db: Db): HubCollections {
  return {
    skills: db.collection<SkillRecord>(SKILLS_COLLECTION),
    state: db.collection<SkillStateRecord>(SKILL_STATE_COLLECTION),
  };
}
