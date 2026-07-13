// 域名归属验证端口（SITE-REAL）：查 host 的 TXT 记录，返回扁平化后的记录字符串列表。
// 由 application 层编排（读 token → lookupTxt → 比对 → 落 verified），infra 提供 node:dns 实现。
export interface DomainVerifier {
  lookupTxt(host: string): Promise<string[]>;
}
