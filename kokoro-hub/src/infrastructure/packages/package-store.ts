// 包体存储（内容寻址 zip；local/s3 双档同一接口）——TS 重写 agent hub.py 的
// LocalPackageStore / S3PackageStore 语义：同 ref 幂等（已存在跳过），永不覆盖异内容。

import { PackageStoreError } from "../../domain/errors.js";
import type { StoreLocation } from "../../config/storage.js";
import { LocalPackageStore } from "./local-package-store.js";
import { S3PackageStore, type S3StoreCredentials } from "./s3-package-store.js";

export interface PackageStore {
  put(ref: string, data: Buffer): Promise<void>;
  get(ref: string): Promise<Buffer>;
}

export function makePackageStore(
  location: StoreLocation,
  credentials: S3StoreCredentials | null,
): PackageStore {
  if (location.type === "local") {
    return new LocalPackageStore(location.root);
  }
  if (credentials === null) {
    throw new PackageStoreError("hub s3 store requires credentials (env-only, ADR-010)");
  }
  return new S3PackageStore(location, credentials);
}
