import { SecretNotResolvableError } from "../domain/errors.js";
import type { McpSecretRepository, SecretListItem } from "../domain/mcp-secret-repository.js";
import type { SecretCipher } from "../domain/secret-cipher.js";
import { generateSecretHandle } from "../domain/secret-handle.js";

// MCP secret broker 应用层（HUB 半场）：编排句柄生成 + cipher 加解密 + 仓储。
// 明文只进不出——create 收明文即刻加密，绝不落库明文；resolve 是唯一明文出口（授权 runtime caller）。
export class McpSecretService {
  constructor(
    private readonly repository: McpSecretRepository,
    private readonly cipher: SecretCipher,
  ) {}

  // self 面创建：明文进 → 生成不透明句柄 → cipher 封 → 落库；只回句柄，值绝不出。
  async create(scope: string, name: string, value: string): Promise<{ handle: string }> {
    const handle = generateSecretHandle();
    const encrypted = this.cipher.encrypt(value);
    await this.repository.create({
      scope,
      handle,
      name,
      ciphertext: encrypted.ciphertext,
      keyId: encrypted.keyId,
    });
    return { handle };
  }

  // self 面列表：只出句柄/命名/创建时间，绝不含值或密文。
  async list(scope: string): Promise<SecretListItem[]> {
    return this.repository.list(scope);
  }

  // self 面软删：幂等，仅限本 scope。
  async delete(scope: string, handle: string): Promise<void> {
    await this.repository.softDelete(scope, handle);
  }

  // 归属校验（MCP 注册 secret_ref=handle: 时用）：句柄须属本 namespace 且活跃。
  // 走 resolve 的密文命中判定，绝不解密——只回真/假，不泄露值。
  async owns(scope: string, handle: string): Promise<boolean> {
    const found = await this.repository.resolve(scope, [handle]);
    return found.length === 1;
  }

  // runtime 面解析（唯一明文出口）：全有或全无——任一句柄不属本 namespace 或不可解，
  // 一律抛 SecretNotResolvableError（路由 404，不回显句柄），跨 namespace 不泄露存在性。
  async resolve(scope: string, handles: readonly string[]): Promise<Record<string, string>> {
    const unique = [...new Set(handles)];
    if (unique.length === 0) {
      return {};
    }
    const found = await this.repository.resolve(scope, unique);
    if (found.length !== unique.length) {
      throw new SecretNotResolvableError();
    }
    const out: Record<string, string> = {};
    for (const item of found) {
      out[item.handle] = this.cipher.decrypt({ ciphertext: item.ciphertext, keyId: item.keyId });
    }
    return out;
  }
}
