import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import {
  hubCollections,
  type HubCollections,
  type McpServerRecord,
  type SkillRecord,
} from "../../src/infrastructure/mongo/mongo-client.js";

export function hubTestMongoUrl(): string {
  return process.env.KOKORO_HUB_MONGO_URL ?? "mongodb://127.0.0.1:27017";
}

// 每个测试文件独立库（hub_test_ 前缀 + 随机后缀），afterAll dropDatabase 清理，互不干扰。
export function hubTestDbName(label: string): string {
  return `hub_test_${label}_${randomUUID().slice(0, 8)}`;
}

export interface TestHub {
  client: MongoClient;
  collections: HubCollections;
  dropDatabase: () => Promise<void>;
  clean: () => Promise<void>;
}

export async function connectTestHub(dbName: string): Promise<TestHub> {
  const client = new MongoClient(hubTestMongoUrl());
  await client.connect();
  const db = client.db(dbName);
  const collections = hubCollections(db);
  return {
    client,
    collections,
    dropDatabase: async () => {
      await db.dropDatabase();
    },
    clean: async () => {
      await collections.skills.deleteMany({});
      await collections.state.deleteMany({});
      await collections.revisions.deleteMany({});
      await collections.mcpServers.deleteMany({});
    },
  };
}

// 完整合法 SkillRecord 夹具（上传写面在 HUB-2，本期测试直插固定数据构造读/写场景）。
export function skillFixture(overrides: Partial<SkillRecord> & Pick<SkillRecord, "scope" | "name">): SkillRecord {
  return {
    description: `desc-${overrides.name}`,
    skill_md: `# ${overrides.name}`,
    files_manifest: [{ path: "SKILL.md", size: 16 }],
    file_count: 1,
    package_size: 100,
    content_hash: `hash-${overrides.scope}-${overrides.name}`,
    package_ref: `skills/${overrides.scope}/${overrides.name}/hash.zip`,
    source: "deploy",
    revision: 1,
    official_enabled: true,
    official_required: false,
    updated_at: Date.now(),
    deleted_at: null,
    ...overrides,
  };
}

export async function insertSkill(
  collections: HubCollections,
  overrides: Partial<SkillRecord> & Pick<SkillRecord, "scope" | "name">,
): Promise<void> {
  await collections.skills.insertOne(skillFixture(overrides));
}

// 完整合法 McpServerRecord 夹具（HUB-3）：直插构造池/启停/软删读场景，写面经 HTTP 注册。
export function mcpServerFixture(
  overrides: Partial<McpServerRecord> & Pick<McpServerRecord, "scope" | "name">,
): McpServerRecord {
  return {
    transport: "http",
    url: `https://mcp.example/${overrides.scope}/${overrides.name}`,
    allowed_tools: [],
    secret_ref: null,
    enabled: true,
    updated_at: Date.now(),
    deleted_at: null,
    ...overrides,
  };
}

export async function insertMcpServer(
  collections: HubCollections,
  overrides: Partial<McpServerRecord> & Pick<McpServerRecord, "scope" | "name">,
): Promise<void> {
  await collections.mcpServers.insertOne(mcpServerFixture(overrides));
}
