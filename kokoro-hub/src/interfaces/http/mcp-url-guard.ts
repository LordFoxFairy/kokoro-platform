// MCP server url 注册预校验（MCP-SECRET 半场 item 4）：注册时挡住指向内网/元数据面的 url。
// self 面（门后生效）只收 https 且解析后不得落在 loopback/private/link-local/multicast/metadata 网段；
// http/localhost 仅 admin 面 + 显式 allowInsecure（KOKORO_HUB_ALLOW_INSECURE_URL=1，test profile）。
// 注意：这是注册期静态防线；连接期动态 egress guard（防 DNS rebinding、锁定解析 IP）在 AGENT 半场。

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type UrlValidation = { ok: true } | { ok: false; reason: string };

export interface UrlGuardOptions {
  // 允许 http + 私网/本机（admin 面 + KOKORO_HUB_ALLOW_INSECURE_URL=1，仅本地/test）。
  allowInsecure: boolean;
  // 可注入解析器便于测试（返回 IP 串数组）；缺省用 node dns.promises.lookup 全量 A/AAAA。
  resolver?: (hostname: string) => Promise<string[]>;
}

// 默认解析器：getaddrinfo 全量地址（含 /etc/hosts，贴合 HTTP 客户端实际会连的 IP）。
async function defaultResolver(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function ipv4ToOctets(ip: string): number[] | null {
  if (isIP(ip) !== 4) {
    return null;
  }
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  return octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? octets
    : null;
}

// 禁网段（SSRF 防线）：本机/私网/共享(CGNAT)/链路本地(含 169.254.169.254 元数据)/组播/保留。
function isForbiddenIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0) return true; // 0.0.0.0/8 本网络/未指定
  if (a === 10) return true; // 10/8 私网
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT 共享
  if (a >= 224) return true; // 224/4 组播 + 240/4 保留（含 255.255.255.255 广播）
  return false;
}

// IPv6 文本 → 16 字节；支持 :: 压缩与尾部内嵌 IPv4。非法返回 null。
function ipv6ToBytes(ip: string): Uint8Array | null {
  if (isIP(ip) !== 6) {
    return null;
  }
  let head = ip;
  const zoneIdx = head.indexOf("%"); // 去掉 scope id（fe80::1%eth0）
  if (zoneIdx !== -1) {
    head = head.slice(0, zoneIdx);
  }
  const doubleColon = head.split("::");
  if (doubleColon.length > 2) {
    return null;
  }
  const bytes = new Uint8Array(16);
  const toHextets = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups = part.split(":");
    const values: number[] = [];
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i] ?? "";
      if (group.includes(".")) {
        // 内嵌 IPv4 只能在末段：拆成两个 hextet。
        if (i !== groups.length - 1) {
          return null;
        }
        const octets = ipv4ToOctets(group);
        if (octets === null) {
          return null;
        }
        values.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        values.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }
      const n = Number.parseInt(group, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
        return null;
      }
      values.push(n);
    }
    return values;
  };
  if (doubleColon.length === 2) {
    const left = toHextets(doubleColon[0] ?? "");
    const right = toHextets(doubleColon[1] ?? "");
    if (left === null || right === null || left.length + right.length > 8) {
      return null;
    }
    const full = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
    for (let i = 0; i < 8; i += 1) {
      bytes[i * 2] = (full[i] ?? 0) >> 8;
      bytes[i * 2 + 1] = (full[i] ?? 0) & 0xff;
    }
  } else {
    const full = toHextets(head);
    if (full === null || full.length !== 8) {
      return null;
    }
    for (let i = 0; i < 8; i += 1) {
      bytes[i * 2] = (full[i] ?? 0) >> 8;
      bytes[i * 2 + 1] = (full[i] ?? 0) & 0xff;
    }
  }
  return bytes;
}

function isForbiddenIpv6(bytes: Uint8Array): boolean {
  const b = (i: number): number => bytes[i] ?? 0;
  // IPv4-mapped ::ffff:a.b.c.d → 按内嵌 IPv4 判（防 ::ffff:169.254.169.254 绕过）。
  const mapped =
    b(0) === 0 && b(1) === 0 && b(2) === 0 && b(3) === 0 &&
    b(4) === 0 && b(5) === 0 && b(6) === 0 && b(7) === 0 &&
    b(8) === 0 && b(9) === 0 && b(10) === 0xff && b(11) === 0xff;
  if (mapped) {
    return isForbiddenIpv4([b(12), b(13), b(14), b(15)]);
  }
  const allZeroExceptLast = bytes.slice(0, 15).every((x) => x === 0);
  if (allZeroExceptLast && b(15) === 0) return true; // :: 未指定
  if (allZeroExceptLast && b(15) === 1) return true; // ::1 loopback
  if ((b(0) & 0xfe) === 0xfc) return true; // fc00::/7 唯一本地地址(ULA)
  if (b(0) === 0xfe && (b(1) & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  if (b(0) === 0xff) return true; // ff00::/8 组播
  return false;
}

function isForbiddenIp(ip: string): boolean {
  const octets = ipv4ToOctets(ip);
  if (octets !== null) {
    return isForbiddenIpv4(octets);
  }
  const bytes = ipv6ToBytes(ip);
  if (bytes !== null) {
    return isForbiddenIpv6(bytes);
  }
  // 无法判定的地址形状：fail-closed，拒。
  return true;
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
  // allowInsecure（admin test profile）：允许 http/localhost/私网，跳过网段解析防线。
  if (options.allowInsecure) {
    return { ok: true };
  }
  // hostname 去掉 IPv6 方括号。
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  // IP 字面量：直接判网段，不解析。
  if (isIP(host) !== 0) {
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
