// MCP server url 注册预校验（MCP-SECRET 半场 item 4）：注册时挡住指向内网/元数据面的 url。
// 默认只收 https，且 literal / DNS 每个答案都必须是公网单播；所有 special/non-unicast 一律拒绝。
// admin 面显式 allowInsecure 只放宽 http scheme，绝不放宽地址分类防线。
// 注意：这是注册期静态防线；连接期动态 egress guard（防 DNS rebinding、锁定解析 IP）在 AGENT 半场。

import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export type UrlValidation = { ok: true } | { ok: false; reason: string };

export interface UrlGuardOptions {
  // 仅允许额外使用 http scheme；公网单播地址约束始终生效。
  allowInsecure: boolean;
  // 可注入解析器便于测试（返回 IP 串数组）；缺省用 node dns.promises.lookup 全量 A/AAAA。
  resolver?: (hostname: string) => Promise<string[]>;
}

// 默认解析器：getaddrinfo 全量地址（含 /etc/hosts，贴合 HTTP 客户端实际会连的 IP）。
async function defaultResolver(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function isForbiddenIp(ip: string): boolean {
  try {
    // process 将 IPv4-mapped IPv6 归一为 IPv4，使 literal 与 DNS 答案共用同一分类器。
    return ipaddr.process(ip).range() !== "unicast";
  } catch {
    // 无法解析的地址形状：fail-closed。
    return true;
  }
}

export async function validateMcpServerUrl(
  rawUrl: string,
  options: UrlGuardOptions,
): Promise<UrlValidation> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url is malformed" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "url must not embed credentials" };
  }
  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  if (!isHttps && !(isHttp && options.allowInsecure)) {
    return { ok: false, reason: "url must use https" };
  }
  // hostname 去掉 IPv6 方括号。
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  // IP 字面量：直接判网段，不解析。
  if (ipaddr.isValid(host)) {
    return isForbiddenIp(host)
      ? { ok: false, reason: "url resolves to a disallowed address range" }
      : { ok: true };
  }
  const resolver = options.resolver ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, reason: "url host could not be resolved" };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "url host could not be resolved" };
  }
  // 全量解析地址逐个校验：任一落在禁网段即拒（挡 DNS 指向内网/元数据）。
  for (const address of addresses) {
    if (isForbiddenIp(address)) {
      return { ok: false, reason: "url resolves to a disallowed address range" };
    }
  }
  return { ok: true };
}
