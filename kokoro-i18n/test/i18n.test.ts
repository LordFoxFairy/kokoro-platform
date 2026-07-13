import { describe, expect, it } from "vitest";
import { createI18n, interpolate } from "../src/index.js";

type Locale = "zh" | "en";
type Key = "greeting" | "count" | "onlyZh";

const source: Record<Key, string> = {
  greeting: "你好 {name}",
  count: "共 {n} 项",
  onlyZh: "仅中文",
};

const i18n = createI18n<Locale, Key>({
  locales: ["zh", "en"],
  defaultLocale: "zh",
  source,
  overrides: {
    en: { greeting: "Hello {name}", count: "{n} items" },
  },
});

describe("interpolate", () => {
  it("returns template unchanged when no vars", () => {
    expect(interpolate("你好 {name}")).toBe("你好 {name}");
  });

  it("substitutes string and number vars", () => {
    expect(interpolate("你好 {name}，共 {n}", { name: "阿岚", n: 3 })).toBe("你好 阿岚，共 3");
  });

  it("keeps placeholder when var missing", () => {
    expect(interpolate("你好 {name}", { other: "x" })).toBe("你好 {name}");
  });
});

describe("negotiate", () => {
  it("prefers valid stored locale", () => {
    expect(i18n.negotiate("en", ["zh-CN"])).toBe("en");
  });

  it("ignores invalid stored and matches navigator prefix", () => {
    expect(i18n.negotiate("fr", ["en-US", "zh"])).toBe("en");
  });

  it("falls back to default when nothing matches", () => {
    expect(i18n.negotiate(null, ["fr-FR"])).toBe("zh");
  });

  it("falls back to default with no signals", () => {
    expect(i18n.negotiate(undefined)).toBe("zh");
  });
});

describe("translate", () => {
  it("uses source for default locale", () => {
    expect(i18n.translate("zh", "greeting", { name: "阿岚" })).toBe("你好 阿岚");
  });

  it("uses override for non-default locale", () => {
    expect(i18n.translate("en", "count", { n: 5 })).toBe("5 items");
  });

  it("falls back to source when override missing the key", () => {
    expect(i18n.translate("en", "onlyZh")).toBe("仅中文");
  });

  it("returns the key itself when unknown", () => {
    expect(i18n.translate("zh", "missing" as Key)).toBe("missing");
  });
});

describe("createI18n without overrides", () => {
  const bare = createI18n<Locale, Key>({ locales: ["zh", "en"], defaultLocale: "zh", source });
  it("resolves source for any locale", () => {
    expect(bare.translate("en", "onlyZh")).toBe("仅中文");
  });
});
