import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMcpServerRepository } from "../../src/infrastructure/mongo/mongo-mcp-server-repository.js";
import type { UpsertMcpServerInput } from "../../src/domain/mcp-repository.js";
import { connectTestHub, hubTestDbName, insertMcpServer, type TestHub } from "./helpers.js";

// MCP-REVISION 三分离场景（纲领原文）：配置版本锁定 / 紧急撤销 / secret 轮换。
// 直打真 Mongo 仓储，验证 revision 簿记 + 不可变快照 + 活文档 fail-closed 现况。
const NS = "ns-rev";

let hub: TestHub;
let repo: MongoMcpServerRepository;

function serverInput(over: Partial<UpsertMcpServerInput> = {}): UpsertMcpServerInput {
  return {
    scope: NS,
    name: "github",
    transport: "streamable_http",
    url: "https://mcp.example/gh",
    allowedTools: ["search"],
    secretRef: null,
    ...over,
  };
}

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("rev"));
  repo = new MongoMcpServerRepository(hub.collections);
}
const ready = init();

describe("MCP-REVISION 簿记与三分离场景", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("首注册 revision=1 并落一行快照", async () => {
    const view = await repo.upsertServer(serverInput());
    expect(view.revision).toBe(1);
    const rows = await hub.collections.mcpServerRevisions.find({ scope: NS, name: "github" }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe(1);
  });

  it("内容不变的重注册幂等短路：不 bump revision、不新增快照行", async () => {
    await repo.upsertServer(serverInput());
    const again = await repo.upsertServer(serverInput());
    expect(again.revision).toBe(1);
    const rows = await hub.collections.mcpServerRevisions.find({ scope: NS, name: "github" }).toArray();
    expect(rows).toHaveLength(1);
  });

  it("场景A 配置版本锁定：改版 bump 到 2，旧 revision 快照仍锁原配置", async () => {
    await repo.upsertServer(serverInput({ url: "https://mcp.example/v1" }));
    const grantsV1 = await repo.resolveGrants(NS);
    expect(grantsV1[0]?.revision).toBe(1);
    const hashV1 = grantsV1[0]?.config_hash;

    // 改版（url 变）→ revision 2。
    const v2 = await repo.upsertServer(serverInput({ url: "https://mcp.example/v2" }));
    expect(v2.revision).toBe(2);
    const grantsV2 = await repo.resolveGrants(NS);
    expect(grantsV2[0]?.revision).toBe(2);
    expect(grantsV2[0]?.config_hash).not.toBe(hashV1);

    // 旧会话锁 revision=1：快照仍返回原 url + 原 hash（不可变）。
    const lockedV1 = await repo.getRevisionSnapshot(NS, "github", 1);
    expect(lockedV1?.snapshot.url).toBe("https://mcp.example/v1");
    expect(lockedV1?.snapshot.config_hash).toBe(hashV1);
    // 新会话取 revision=2：新 url。
    const lockedV2 = await repo.getRevisionSnapshot(NS, "github", 2);
    expect(lockedV2?.snapshot.url).toBe("https://mcp.example/v2");
  });

  it("场景B 紧急撤销：disable/软删对旧会话立即 fail-closed（快照在，活文档说停就停）", async () => {
    await repo.upsertServer(serverInput());
    const before = await repo.getRevisionSnapshot(NS, "github", 1);
    expect(before?.live).toEqual({ enabled: true, deleted: false });

    await repo.setEnabled(NS, "github", false);
    const disabled = await repo.getRevisionSnapshot(NS, "github", 1);
    expect(disabled?.snapshot.revision).toBe(1); // 快照仍在
    expect(disabled?.live.enabled).toBe(false); // 活文档现况即刻反映

    await repo.markDeleted(NS, "github");
    const deleted = await repo.getRevisionSnapshot(NS, "github", 1);
    expect(deleted?.live.deleted).toBe(true);
  });

  it("场景C secret 轮换：同 handle 引用不改 secret_ref → 不 bump；换 handle → bump", async () => {
    const handleA = "handle:srt_0123456789abcdef0123456789abcdef";
    const handleB = "handle:srt_ffffffffffffffffffffffffffffffff";
    await repo.upsertServer(serverInput({ secretRef: handleA }));
    // 同配置同 handle 重注册（模拟句柄背后明文轮换：secret_ref 不变）→ 不 bump。
    const rotated = await repo.upsertServer(serverInput({ secretRef: handleA }));
    expect(rotated.revision).toBe(1);
    let rows = await hub.collections.mcpServerRevisions.find({ scope: NS, name: "github" }).toArray();
    expect(rows).toHaveLength(1);

    // 换到新句柄（secret_ref 变）→ 内容变 → bump 到 2。
    const switched = await repo.upsertServer(serverInput({ secretRef: handleB }));
    expect(switched.revision).toBe(2);
    rows = await hub.collections.mcpServerRevisions.find({ scope: NS, name: "github" }).toArray();
    expect(rows).toHaveLength(2);
  });

  it("存量迁移：无 revision 的活文档首次 resolve 按 revision=1 补齐并 append 快照行（幂等）", async () => {
    // 直插存量文档（fixture 不写 revision）。
    await insertMcpServer(hub.collections, { scope: NS, name: "legacy", url: "https://mcp.example/legacy" });
    const grants1 = await repo.resolveGrants(NS);
    const legacy1 = grants1.find((g) => g.name === "legacy");
    expect(legacy1?.revision).toBe(1);

    const doc = await hub.collections.mcpServers.findOne({ scope: NS, name: "legacy" });
    expect(doc?.revision).toBe(1);
    // 幂等：二次 resolve 不重复落行。
    await repo.resolveGrants(NS);
    const rows = await hub.collections.mcpServerRevisions.find({ scope: NS, name: "legacy" }).toArray();
    expect(rows).toHaveLength(1);
  });
});
