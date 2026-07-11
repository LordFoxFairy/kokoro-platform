// 入库校验清单（skills-design §5，逐条对齐 agent 仓 kokoro_agent/skills/hub.py 的
// validate_package / package.py 的 parse_frontmatter）：每条都是安全/卫生边界，fail-loud 不入库。
// 常量为契约值，改动必须与 agent 侧同步（双层守门：hub 写面 + agent 装配防御各自校验）。

import { parse as parseYaml } from "yaml";
import { SkillValidationError } from "./errors.js";

export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set([
  "official",
  "skill",
  "skills",
  "general",
  "system",
]);
export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_PACKAGE_BYTES = 30 * 1024 * 1024;
export const MAX_SKILL_DESCRIPTION_LEN = 500;

// 上传 zip 解包总字节硬顶（zip bomb 防线）：解包前按 central directory 声明尺寸累计拒绝。
export const MAX_UPLOAD_UNPACKED_BYTES = 200 * 1024 * 1024;

// 上传 zip 原始字节硬顶（multipart fileSize 限制 / base64 解码后同口径）。
export const MAX_UPLOAD_ZIP_BYTES = 64 * 1024 * 1024;

export interface SkillFrontmatter {
  name: string;
  description: string;
}

// SKILL.md 头部契约：--- 包裹的 YAML 头、name 与目录同名、description 非空字符串。
export function parseFrontmatter(name: string, skillMd: string): SkillFrontmatter {
  if (!skillMd.startsWith("---")) {
    throw new SkillValidationError(`skill '${name}': SKILL.md missing YAML frontmatter (--- block)`);
  }
  const end = skillMd.indexOf("---", 3);
  if (end === -1) {
    throw new SkillValidationError(`skill '${name}': unterminated frontmatter block`);
  }
  const raw: unknown = parseYaml(skillMd.slice(3, end));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SkillValidationError(`skill '${name}': frontmatter is not a mapping`);
  }
  const meta = raw as Record<string, unknown>;
  // strict 语义对齐 agent pydantic strict：非字符串（如 YAML 数字）直接拒绝，不做隐式转换。
  if (typeof meta.name !== "string") {
    throw new SkillValidationError(`skill '${name}': frontmatter name must be a string`);
  }
  if (typeof meta.description !== "string") {
    throw new SkillValidationError(`skill '${name}': frontmatter description must be a string`);
  }
  if (meta.name !== name) {
    throw new SkillValidationError(
      `skill '${name}': frontmatter name '${meta.name}' must match directory name`,
    );
  }
  if (meta.description.trim() === "") {
    throw new SkillValidationError(`skill '${name}': frontmatter description must be non-empty`);
  }
  return { name: meta.name, description: meta.description };
}

export interface ValidatedPackage {
  description: string;
  packageSize: number;
}

// 路径穿越判定与 hub.py 同口径：绝对路径或含 .. 段即拒绝。
function isUnsafePath(rel: string): boolean {
  if (rel.startsWith("/")) {
    return true;
  }
  return rel.split("/").some((part) => part === "..");
}

export function validatePackage(name: string, files: Record<string, string>): ValidatedPackage {
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillValidationError(
      `skill name '${name}' invalid (lowercase, digits, hyphen, 2-64 chars)`,
    );
  }
  if (RESERVED_SKILL_NAMES.has(name)) {
    throw new SkillValidationError(`skill name '${name}' is reserved`);
  }
  const paths = Object.keys(files);
  if (paths.length > MAX_SKILL_FILES) {
    throw new SkillValidationError(
      `skill '${name}' has ${paths.length} files (max ${MAX_SKILL_FILES})`,
    );
  }
  let size = 0;
  for (const rel of paths) {
    if (isUnsafePath(rel)) {
      throw new SkillValidationError(`skill '${name}' has unsafe path '${rel}'`); // 路径穿越
    }
    size += Buffer.byteLength(files[rel] ?? "", "utf8");
  }
  if (size > MAX_SKILL_PACKAGE_BYTES) {
    throw new SkillValidationError(`skill '${name}' package too large (${size} bytes)`);
  }
  const meta = parseFrontmatter(name, files["SKILL.md"] ?? ""); // 缺/坏 SKILL.md fail-loud
  if (meta.description.length > MAX_SKILL_DESCRIPTION_LEN) {
    throw new SkillValidationError(`skill '${name}' description too long`);
  }
  for (const [field, value] of [
    ["name", name],
    ["description", meta.description],
  ] as const) {
    if (value.includes("<") || value.includes(">")) {
      throw new SkillValidationError(`skill '${name}' ${field} contains angle brackets`); // 注入防线
    }
  }
  return { description: meta.description, packageSize: size };
}
