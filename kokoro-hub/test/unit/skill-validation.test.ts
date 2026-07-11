import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SkillValidationError } from "../../src/domain/errors.js";
import { contentHashOf, packageRef, sortedFilePaths } from "../../src/domain/package.js";
import {
  MAX_SKILL_DESCRIPTION_LEN,
  MAX_SKILL_FILES,
  MAX_SKILL_PACKAGE_BYTES,
  parseFrontmatter,
  validatePackage,
} from "../../src/domain/validation.js";
import { unzipTextFiles, zipTextFiles } from "../../src/infrastructure/zip.js";

const STYLE_MD = "---\nname: style\ndescription: 先结论后论据\n---\n正文\n";

describe("validatePackage (aligned with agent hub.py validate_package)", () => {
  it("accepts a valid package and returns description plus utf-8 size", () => {
    const files = { "SKILL.md": STYLE_MD, "notes.txt": "hello" };
    const result = validatePackage("style", files);
    expect(result.description).toBe("先结论后论据");
    expect(result.packageSize).toBe(
      Buffer.byteLength(STYLE_MD, "utf8") + Buffer.byteLength("hello", "utf8"),
    );
  });

  // 恶意/坏包负向逐条（skills-design §5 清单）。
  it.each([
    ["uppercase name", "Bad_Name", { "SKILL.md": STYLE_MD }, /invalid/],
    ["single-char name", "a", { "SKILL.md": STYLE_MD }, /invalid/],
    ["reserved name", "official", { "SKILL.md": STYLE_MD }, /reserved/],
    ["missing SKILL.md", "style", { "readme.md": "no skill" }, /frontmatter/],
    ["path traversal", "style", { "SKILL.md": STYLE_MD, "../evil.py": "x" }, /unsafe path/],
    ["nested traversal", "style", { "SKILL.md": STYLE_MD, "a/../../evil.py": "x" }, /unsafe path/],
    ["absolute path", "style", { "SKILL.md": STYLE_MD, "/abs.py": "x" }, /unsafe path/],
    [
      "angle bracket injection",
      "style",
      { "SKILL.md": "---\nname: style\ndescription: 有<注入>风险\n---\n正文" },
      /angle brackets/,
    ],
    [
      "frontmatter name mismatch",
      "style",
      { "SKILL.md": "---\nname: other\ndescription: d\n---\nx" },
      /must match directory name/,
    ],
    [
      "empty description",
      "style",
      { "SKILL.md": "---\nname: style\ndescription: '  '\n---\nx" },
      /non-empty/,
    ],
    [
      "non-string description",
      "style",
      { "SKILL.md": "---\nname: style\ndescription: 500\n---\nx" },
      /must be a string/,
    ],
    ["unterminated frontmatter", "style", { "SKILL.md": "---\nname: style" }, /unterminated/],
  ])("rejects %s", (_label, name, files, match) => {
    expect(() => validatePackage(name, files)).toThrowError(match);
    expect(() => validatePackage(name, files)).toThrowError(SkillValidationError);
  });

  it("rejects too many files", () => {
    const files: Record<string, string> = { "SKILL.md": STYLE_MD };
    for (let i = 0; i <= MAX_SKILL_FILES; i += 1) {
      files[`f${i}.txt`] = "x";
    }
    expect(() => validatePackage("style", files)).toThrowError(/files \(max/);
  });

  it("rejects an oversized package", () => {
    const files = { "SKILL.md": STYLE_MD, "big.txt": "a".repeat(MAX_SKILL_PACKAGE_BYTES) };
    expect(() => validatePackage("style", files)).toThrowError(/too large/);
  });

  it("rejects an overlong description", () => {
    const description = "d".repeat(MAX_SKILL_DESCRIPTION_LEN + 1);
    const files = { "SKILL.md": `---\nname: style\ndescription: ${description}\n---\nx` };
    expect(() => validatePackage("style", files)).toThrowError(/description too long/);
  });
});

describe("parseFrontmatter", () => {
  it("keeps extra frontmatter keys tolerated (passthrough contract)", () => {
    const meta = parseFrontmatter("style", "---\nname: style\ndescription: d\nextra: 1\n---\nx");
    expect(meta).toEqual({ name: "style", description: "d" });
  });
});

describe("contentHashOf (byte parity with agent hub.py content_hash_of)", () => {
  // 期望值由 python json.dumps(dict(sorted(...)), ensure_ascii=False) + sha256 预计算钉死。
  it("matches the python vector for ascii files", () => {
    const files = {
      "notes.txt": "hello",
      "SKILL.md": "---\nname: style\ndescription: demo skill\n---\nbody\n",
    };
    expect(contentHashOf(files)).toBe(
      "cb44e2e1ccfbc9e87826b98b070162f508cbb2a77f5d118b8ffeeeb74c9e5705",
    );
  });

  it("matches the python vector for unicode, quotes, backslash and tab", () => {
    const files = {
      "SKILL.md": '---\nname: pdf\ndescription: 中文"引号"与\\反斜杠\n---\n正文\t带控制符\n',
    };
    expect(contentHashOf(files)).toBe(
      "06a98428d32006826e1439d65c05850bbbf1fb14f87f7de6614957387ef2252f",
    );
  });

  it("is order-insensitive over input key order", () => {
    expect(contentHashOf({ a: "1", b: "2" })).toBe(contentHashOf({ b: "2", a: "1" }));
  });
});

describe("packageRef", () => {
  it("builds the content-addressed zip key", () => {
    expect(packageRef("ns-1", "writer", "abc")).toBe("skills/ns-1/writer/abc.zip");
  });
});

describe("zip roundtrip", () => {
  it("zips and unzips text files losslessly with sorted stable paths", () => {
    const files = { "b/deep.txt": "深层\n", "a.txt": "first", "SKILL.md": STYLE_MD };
    expect(unzipTextFiles(zipTextFiles(files))).toEqual(files);
    expect(sortedFilePaths(files)).toEqual(["SKILL.md", "a.txt", "b/deep.txt"]);
  });

  it("rejects garbage that is not a zip archive", () => {
    expect(() => unzipTextFiles(Buffer.from("not a zip"))).toThrowError(/invalid zip/);
  });

  it("rejects non-utf8 entries", () => {
    // 手工构造含非法 UTF-8 字节的 zip（文本技能包契约：二进制文件 fail-loud）。
    const bad = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const zipped = Buffer.from(zipSync({ "writer/bin.dat": bad }));
    expect(() => unzipTextFiles(zipped)).toThrowError(/not valid UTF-8/);
  });

  it("skips explicit directory entries", () => {
    const zipped = Buffer.from(zipSync({ "writer/": new Uint8Array(0), "writer/a.txt": new Uint8Array([97]) }));
    expect(unzipTextFiles(zipped)).toEqual({ "writer/a.txt": "a" });
  });

  it("rejects a zip bomb before decompression by declared size", () => {
    const big = new Uint8Array(201 * 1024 * 1024); // > MAX_UPLOAD_UNPACKED_BYTES，零填充压缩后很小。
    const zipped = Buffer.from(zipSync({ "writer/big.bin": big }, { level: 1 }));
    expect(zipped.byteLength).toBeLessThan(1024 * 1024);
    expect(() => unzipTextFiles(zipped)).toThrowError(/zip bomb guard/);
  });

  it("sorts by code point like python sorted(), not by UTF-16 code unit", () => {
    // U+FFFF < U+1F600（😀）按码点；JS 默认码元序会把 😀(高位代理 0xD83D) 排前。
    expect(sortedFilePaths({ "😀": "", "\uFFFF": "" })).toEqual(["\uFFFF", "😀"]);
  });
});
