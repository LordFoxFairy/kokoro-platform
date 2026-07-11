import { PackageStoreError } from "../../src/domain/errors.js";
import type { PackageStore } from "../../src/infrastructure/packages/package-store.js";

// 上传服务单测用的内存包体存储替身（test-only；生产只用 local/s3 真实现）。
// 语义与真实现同构：内容寻址，同 ref 幂等跳过。
export class FakePackageStore implements PackageStore {
  readonly objects = new Map<string, Buffer>();
  readonly failPutRefs = new Set<string>();

  async put(ref: string, data: Buffer): Promise<void> {
    if (this.failPutRefs.has(ref)) {
      throw new PackageStoreError(`simulated put failure for '${ref}'`);
    }
    if (this.objects.has(ref)) {
      return;
    }
    this.objects.set(ref, data);
  }

  async get(ref: string): Promise<Buffer> {
    const data = this.objects.get(ref);
    if (data === undefined) {
      throw new PackageStoreError(`package '${ref}' not found in fake store`);
    }
    return data;
  }
}
