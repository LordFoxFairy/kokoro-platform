// skills 上传写面（HUB-2，spec skills-design §5§6）：preview 纯校验不落任何东西；
// confirm 逐项发布允许部分成功——包体先落（内容寻址，失败则元数据不动）再 Mongo upsert（CAS）。
// 上传归属恒为 scope==namespace（自有包，池语义覆盖同名 official）；official 位只走 seed/管理面。

import { OFFICIAL_SCOPE } from "../domain/constants.js";
import {
  ConcurrentWriteError,
  PackageStoreError,
  QuotaExceededError,
  SkillValidationError,
} from "../domain/errors.js";
import { contentHashOf, packageRef, sortedFilePaths } from "../domain/package.js";
import type { SkillHubRepository, SkillRevisionView } from "../domain/repository.js";
import { validatePackage } from "../domain/validation.js";
import type { PackageStore } from "../infrastructure/packages/package-store.js";
import { unzipTextFiles, zipTextFiles } from "../infrastructure/zip.js";
import type { QuotaLimits } from "./skill-hub-service.js";

export interface UploadFileEntry {
  path: string;
  size: number;
}

// 候选项（preview 面）：invalid 也完整返回 errors 与文件清单，供上传方修包。
export interface UploadCandidate {
  name: string;
  valid: boolean;
  errors: string[];
  description: string | null;
  content_hash: string | null;
  package_size: number;
  file_count: number;
  files: UploadFileEntry[];
  // 归属冲突检测：同名 official 已存在（发布后池内覆盖它）/ 本 namespace 已存在（发布即升版本）。
  conflicts: { official: boolean; namespace: boolean };
}

export interface UploadPreview {
  namespace: string;
  candidates: UploadCandidate[];
}

export type ConfirmStatus = "published" | "unchanged" | "failed";

export interface ConfirmResult {
  name: string;
  status: ConfirmStatus;
  revision: number | null;
  content_hash: string | null;
  error: string | null;
}

interface RawCandidate {
  name: string;
  files: Record<string, string>;
}

// zip 布局契约：根下每个目录 = 一个技能候选（目录名即技能名）；根下裸文件整包拒绝。
function extractCandidates(zip: Buffer): RawCandidate[] {
  const entries = unzipTextFiles(zip);
  const byName = new Map<string, Record<string, string>>();
  for (const [path, content] of Object.entries(entries)) {
    const slash = path.indexOf("/");
    if (slash <= 0) {
      throw new SkillValidationError(
        `zip root must contain only skill directories (found top-level file '${path}')`,
      );
    }
    const name = path.slice(0, slash);
    const rel = path.slice(slash + 1);
    if (rel === "") {
      continue;
    }
    const files = byName.get(name) ?? {};
    files[rel] = content;
    byName.set(name, files);
  }
  if (byName.size === 0) {
    throw new SkillValidationError("zip contains no skill directories");
  }
  return [...byName.entries()].map(([name, files]) => ({ name, files }));
}

function manifestOf(files: Record<string, string>): UploadFileEntry[] {
  return sortedFilePaths(files).map((path) => ({
    path,
    size: Buffer.byteLength(files[path] ?? "", "utf8"),
  }));
}

export class SkillUploadService {
  constructor(
    private readonly repository: SkillHubRepository,
    private readonly packageStore: PackageStore | null,
    private readonly quotaLimits: QuotaLimits,
  ) {}

  async preview(namespace: string, zip: Buffer): Promise<UploadPreview> {
    const candidates: UploadCandidate[] = [];
    for (const raw of extractCandidates(zip)) {
      const files = manifestOf(raw.files);
      const conflicts = {
        official: (await this.repository.findActive(OFFICIAL_SCOPE, raw.name)) !== null,
        namespace: (await this.repository.findActive(namespace, raw.name)) !== null,
      };
      try {
        const validated = validatePackage(raw.name, raw.files);
        candidates.push({
          name: raw.name,
          valid: true,
          errors: [],
          description: validated.description,
          content_hash: contentHashOf(raw.files),
          package_size: validated.packageSize,
          file_count: files.length,
          files,
          conflicts,
        });
      } catch (error) {
        if (!(error instanceof SkillValidationError)) {
          throw error;
        }
        candidates.push({
          name: raw.name,
          valid: false,
          errors: [error.message],
          description: null,
          content_hash: null,
          package_size: 0,
          file_count: files.length,
          files,
          conflicts,
        });
      }
    }
    return { namespace, candidates };
  }

  // 逐项发布，单项失败不阻断其余项；包体 zip 按 content_hash 寻址永存（回滚零成本）。
  async confirm(namespace: string, zip: Buffer, names: string[] | null): Promise<ConfirmResult[]> {
    if (this.packageStore === null) {
      // 对齐 agent load_storage_file 缺省语义：hub 节未配置 = 上传写面不可用，fail-loud。
      throw new PackageStoreError("package store unconfigured (storage yaml hub node missing)");
    }
    const store = this.packageStore;
    const candidates = extractCandidates(zip);
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    const selected = names === null ? [...byName.keys()] : [...new Set(names)];

    const usage = await this.repository.quotaUsage(namespace);
    let usedCount = usage.packageCount;
    let usedBytes = usage.packageBytes;

    const results: ConfirmResult[] = [];
    for (const name of selected) {
      const raw = byName.get(name);
      if (raw === undefined) {
        results.push(failed(name, `skill '${name}' not present in uploaded zip`));
        continue;
      }
      try {
        const validated = validatePackage(raw.name, raw.files);
        const digest = contentHashOf(raw.files);
        const existing = await this.repository.findActive(namespace, raw.name);
        if (existing !== null && existing.contentHash === digest) {
          // 幂等：hash 未变不写库、不落包体、不追加版本历史。
          results.push({
            name: raw.name,
            status: "unchanged",
            revision: existing.revision,
            content_hash: digest,
            error: null,
          });
          continue;
        }
        const nextCount = existing === null ? usedCount + 1 : usedCount;
        const nextBytes = usedBytes - (existing?.packageSize ?? 0) + validated.packageSize;
        if (nextCount > this.quotaLimits.maxPackages || nextBytes > this.quotaLimits.maxBytes) {
          throw new QuotaExceededError(
            `namespace '${namespace}' quota exceeded (${nextCount}/${this.quotaLimits.maxPackages} packages, ${nextBytes}/${this.quotaLimits.maxBytes} bytes)`,
          );
        }
        const ref = packageRef(namespace, raw.name, digest);
        await store.put(ref, zipTextFiles(raw.files)); // 包体先落（内容寻址，失败则元数据不动）。
        const upserted = await this.repository.upsertSkill({
          scope: namespace,
          name: raw.name,
          description: validated.description,
          skillMd: raw.files["SKILL.md"] ?? "",
          filesManifest: manifestOf(raw.files),
          fileCount: Object.keys(raw.files).length,
          packageSize: validated.packageSize,
          contentHash: digest,
          packageRef: ref,
          source: "upload",
        });
        usedCount = nextCount;
        usedBytes = nextBytes;
        results.push({
          name: raw.name,
          status: "published",
          revision: upserted.revision,
          content_hash: digest,
          error: null,
        });
      } catch (error) {
        if (
          error instanceof SkillValidationError ||
          error instanceof QuotaExceededError ||
          error instanceof ConcurrentWriteError ||
          error instanceof PackageStoreError
        ) {
          results.push(failed(name, error.message));
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  async revisions(scope: string, name: string): Promise<SkillRevisionView[]> {
    return this.repository.listRevisions(scope, name);
  }
}

function failed(name: string, error: string): ConfirmResult {
  return { name, status: "failed", revision: null, content_hash: null, error };
}
