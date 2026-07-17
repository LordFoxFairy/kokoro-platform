import type {
  McpGrantView,
  McpServerRepository,
  McpServerRevisionResolution,
  McpServerView,
  UpsertMcpServerInput,
} from "../domain/mcp-repository.js";

// MCP server 注册表服务（HUB-3 + MCP-REVISION）：与 SkillHubService 同构的薄应用层；
// url/secret_ref 形状校验在 http 边界（mcp-schemas / mcp-server-ref），仓储只收已验事实。
// revision 簿记（bump / append 快照 / 迁移）落在仓储；本层只做转发。
export class McpHubService {
  constructor(private readonly repository: McpServerRepository) {}

  async listPool(namespace: string): Promise<McpServerView[]> {
    return this.repository.listPool(namespace);
  }

  // 运营官方目录（admin 面用）：官方 scope 全量含禁用，非租户合并池。
  async listOfficialCatalog(): Promise<McpServerView[]> {
    return this.repository.listOfficialCatalog();
  }

  // 会话快照解析（session 建会话用）：有效池收敛成 McpGrant（含 revision + config_hash）。
  async resolveGrants(namespace: string): Promise<McpGrantView[]> {
    return this.repository.resolveGrants(namespace);
  }

  // 版本快照 + 活文档现况（agent 装配用）：按 (scope,name,revision) 取，未知 revision 返回 null。
  async getRevisionSnapshot(
    scope: string,
    name: string,
    revision: number,
  ): Promise<McpServerRevisionResolution | null> {
    return this.repository.getRevisionSnapshot(scope, name, revision);
  }

  async register(input: UpsertMcpServerInput): Promise<McpServerView> {
    return this.repository.upsertServer(input);
  }

  // 目标不存在由仓储抛 McpServerNotFoundError，路由映射 404。
  async setEnabled(scope: string, name: string, enabled: boolean): Promise<void> {
    await this.repository.setEnabled(scope, name, enabled);
  }

  async markDeleted(scope: string, name: string): Promise<void> {
    await this.repository.markDeleted(scope, name);
  }
}
