// 本地档包体存储：{root}/{ref} 落盘；内容寻址 → 同 ref 即同内容，存在即幂等跳过。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PackageStoreError } from "../../domain/errors.js";
import type { PackageStore } from "./package-store.js";

export class LocalPackageStore implements PackageStore {
  constructor(private readonly root: string) {}

  private resolve(ref: string): string {
    // ref 由 packageRef() 生成（scope/name 均过校验），此处再挡一道穿越以防误用。
    if (ref.startsWith("/") || ref.split("/").some((part) => part === "..")) {
      throw new PackageStoreError(`package ref '${ref}' is unsafe`);
    }
    return join(this.root, ref);
  }

  async put(ref: string, data: Buffer): Promise<void> {
    const target = this.resolve(ref);
    if (existsSync(target)) {
      return; // 内容寻址：同 ref 即同内容，幂等跳过。
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async get(ref: string): Promise<Buffer> {
    const target = this.resolve(ref);
    if (!existsSync(target)) {
      throw new PackageStoreError(`package '${ref}' not found in local store`);
    }
    return readFile(target);
  }
}
