import type {
  McpServerRepository,
  McpServerView,
  UpsertMcpServerInput,
} from "../domain/mcp-repository.js";

// MCP server 注册表服务（HUB-3）：与 SkillHubService 同构的薄应用层；
// url/secret_ref 形状校验在 http 边界（mcp-schemas），仓储只收已验事实。
export class McpHubService {
  constructor(private readonly repository: McpServerRepository) {}

  async listPool(namespace: string): Promise<McpServerView[]> {
    return this.repository.listPool(namespace);
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
