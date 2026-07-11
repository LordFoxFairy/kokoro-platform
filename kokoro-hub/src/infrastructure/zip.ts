// zip 编解码（fflate，标准 zip/deflate——agent 侧 python zipfile 可直接读）。
// 解包带 zip bomb 防线：按 central directory 声明尺寸累计，超硬顶在解压前拒绝。

import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import { SkillValidationError } from "../domain/errors.js";
import { MAX_UPLOAD_UNPACKED_BYTES } from "../domain/validation.js";
import { sortedFilePaths } from "../domain/package.js";

// zip 内容 → { 相对路径: 文本 }；目录项跳过；非 UTF-8 文件 fail-loud（契约=文本技能包，对齐 agent _unzip_files）。
export function unzipTextFiles(data: Buffer): Record<string, string> {
  let declared = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(data), {
      filter: (file) => {
        declared += file.originalSize;
        if (declared > MAX_UPLOAD_UNPACKED_BYTES) {
          throw new SkillValidationError(
            `zip expands past ${MAX_UPLOAD_UNPACKED_BYTES} bytes (zip bomb guard)`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SkillValidationError) {
      throw error;
    }
    throw new SkillValidationError(`invalid zip archive: ${String(error)}`);
  }
  const out: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(unzipped)) {
    if (path.endsWith("/")) {
      continue; // 目录项
    }
    const text = strFromU8(bytes);
    // fflate 宽松解码不抛错：回编码比对捕获非法 UTF-8，坏文件 fail-loud 不入库。
    if (Buffer.compare(Buffer.from(text, "utf8"), Buffer.from(bytes)) !== 0) {
      throw new SkillValidationError(`zip entry '${path}' is not valid UTF-8 text`);
    }
    out[path] = text;
  }
  return out;
}

// { 相对路径: 文本 } → zip 字节（路径排序稳定 + deflate，语义对齐 agent _zip_files）。
export function zipTextFiles(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const path of sortedFilePaths(files)) {
    entries[path] = strToU8(files[path] ?? "");
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}
