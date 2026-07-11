import type {
  McpServerRepository,
  McpServerView,
  UpsertMcpServerInput,
} from "../../src/domain/mcp-repository.js";

// 路由错误映射单测用的内存替身（test-only；生产只用真 Mongo 实现，见 integration/mcp-api）。
export class FakeMcpServerRepository implements McpServerRepository {
  pool: McpServerView[] = [];
  failNextWith: Error | null = null;
  readonly enabledCalls: { scope: string; name: string; enabled: boolean }[] = [];
  readonly deletedCalls: { scope: string; name: string }[] = [];

  private throwIfArmed(): void {
    if (this.failNextWith !== null) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
  }

  async listPool(_namespace: string): Promise<McpServerView[]> {
    this.throwIfArmed();
    return this.pool;
  }

  async upsertServer(input: UpsertMcpServerInput): Promise<McpServerView> {
    this.throwIfArmed();
    return {
      scope: input.scope,
      name: input.name,
      transport: input.transport,
      url: input.url,
      allowed_tools: input.allowedTools,
      secret_ref: input.secretRef,
      enabled: true,
    };
  }

  async setEnabled(scope: string, name: string, enabled: boolean): Promise<void> {
    this.throwIfArmed();
    this.enabledCalls.push({ scope, name, enabled });
  }

  async markDeleted(scope: string, name: string): Promise<void> {
    this.throwIfArmed();
    this.deletedCalls.push({ scope, name });
  }
}
