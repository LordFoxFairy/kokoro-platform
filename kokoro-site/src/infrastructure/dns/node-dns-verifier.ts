import { promises as dns } from "node:dns";
import type { DomainVerifier } from "../../domain/domain-verifier.js";

// node:dns 实现：resolveTxt 返回 string[][]（每记录可分片），拼接成整段再交上层比对。
// 查询失败（NXDOMAIN/无 TXT/超时）不抛，返回空列表 → 上层判为未验证并留 pending。
export class NodeDnsVerifier implements DomainVerifier {
  async lookupTxt(host: string): Promise<string[]> {
    try {
      const records = await dns.resolveTxt(host);
      return records.map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  }
}
