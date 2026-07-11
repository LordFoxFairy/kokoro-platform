// 内容寻址工具：content_hash / package_ref 与 agent 仓 hub.py 逐字节同语义——
// 同一 files 集在双语言算出同一 hash，官方 seed（Python）与用户上传（TS）互相幂等。

import { createHash } from "node:crypto";

// Python sorted() 是码点序；JS 默认 sort 是 UTF-16 码元序，增补面字符会错位——显式按码点比较。
function codePointCompare(a: string, b: string): number {
  const as = Array.from(a);
  const bs = Array.from(b);
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const diff = ((as[i] ?? "").codePointAt(0) ?? -1) - ((bs[i] ?? "").codePointAt(0) ?? -1);
    if (diff !== 0) {
      return diff;
    }
  }
  return as.length - bs.length;
}

export function sortedFilePaths(files: Record<string, string>): string[] {
  return Object.keys(files).sort(codePointCompare);
}

// 复刻 python json.dumps(dict(sorted(...)), ensure_ascii=False) 的默认分隔符（", " 与 ": "）。
// JSON.stringify 与 json.dumps 对 " \ 控制符的转义规则一致，非 ASCII 双方都原样输出。
function canonicalJson(files: Record<string, string>): string {
  const parts = sortedFilePaths(files).map(
    (path) => `${JSON.stringify(path)}: ${JSON.stringify(files[path])}`,
  );
  return `{${parts.join(", ")}}`;
}

export function contentHashOf(files: Record<string, string>): string {
  return createHash("sha256").update(canonicalJson(files), "utf8").digest("hex");
}

export function packageRef(scope: string, name: string, contentHash: string): string {
  return `skills/${scope}/${name}/${contentHash}.zip`;
}
