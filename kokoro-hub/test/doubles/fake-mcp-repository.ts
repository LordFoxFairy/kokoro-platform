import { mcpConfigHash } from "../../src/domain/mcp-config-hash.js";
import type {
  McpGrantView,
  McpServerRepository,
  McpServerRevisionResolution,
  McpServerView,
  UpsertMcpServerInput,
} from "../../src/domain/mcp-repository.js";

// 路由错误映射单测用的内存替身（test-only；生产只用真 Mongo 实现，见 integration/mcp-api）。
export class FakeMcpServerRepository implements McpServerRepository {
  pool: McpServerView[] = [];
  officialCatalog: McpServerView[] = [];
  grants: McpGrantView[] = [];
  snapshot: McpServerRevisionResolution | null = null;
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

  async listOfficialCatalog(): Promise<McpServerView[]> {
    this.throwIfArmed();
    return this.officialCatalog;
  }

  async resolveGrants(_namespace: string): Promise<McpGrantView[]> {
    this.throwIfArmed();
    return this.grants;
  }

  async getRevisionSnapshot(
    _scope: string,
    _name: string,
    _revision: number,
  ): Promise<McpServerRevisionResolution | null> {
    this.throwIfArmed();
    return this.snapshot;
  }

  async upsertServer(input: UpsertMcpServerInput): Promise<McpServerView> {
    this.throwIfArmed();
    return {
      scope: input.scope,
      name: input.name,
      revision: 1,
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

// 便捷：从注册入参造一份 McpGrant（与真仓储 config_hash 同算），供 fake.grants 直填。
export function fakeGrantFrom(input: UpsertMcpServerInput, revision = 1): McpGrantView {
  return {
    scope: input.scope,
    name: input.name,
    revision,
    config_hash: mcpConfigHash({
      transport: input.transport,
      url: input.url,
      allowedTools: input.allowedTools,
      secretRef: input.secretRef,
    }),
  };
}
