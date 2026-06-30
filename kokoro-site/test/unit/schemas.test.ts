import { describe, expect, it } from "vitest";
import {
  listSiteFeatureFlagsQuerySchema,
  resolveSiteQuerySchema,
  upsertSiteAppRequestSchema,
  upsertSiteDomainRequestSchema,
  upsertSiteFeatureFlagRequestSchema,
  upsertSitePolicyRequestSchema,
  upsertSiteRequestSchema,
} from "../../src/interfaces/http/schemas.js";

describe("upsertSiteRequestSchema", () => {
  it("accepts a minimal valid payload", () => {
    const parsed = upsertSiteRequestSchema.parse({ key: "acme", name: "Acme" });
    expect(parsed).toEqual({ key: "acme", name: "Acme" });
  });

  it("accepts a full valid payload with JSON metadata", () => {
    const parsed = upsertSiteRequestSchema.parse({
      key: "acme",
      name: "Acme",
      status: "active",
      defaultLocale: "en",
      timezone: "UTC",
      metadata: { plan: "pro", nested: { flag: true }, list: [1, null, "x"] },
    });
    expect(parsed.metadata).toEqual({ plan: "pro", nested: { flag: true }, list: [1, null, "x"] });
  });

  it.each([
    ["empty key", { key: "", name: "Acme" }],
    ["empty name", { key: "acme", name: "" }],
    ["missing key", { name: "Acme" }],
    ["missing name", { key: "acme" }],
    ["illegal status", { key: "acme", name: "Acme", status: "live" }],
    ["short defaultLocale", { key: "acme", name: "Acme", defaultLocale: "e" }],
    ["empty timezone", { key: "acme", name: "Acme", timezone: "" }],
    ["unknown field rejected by strict", { key: "acme", name: "Acme", extra: 1 }],
  ])("rejects %s", (_label, payload) => {
    expect(upsertSiteRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("upsertSiteDomainRequestSchema", () => {
  it("accepts a minimal valid payload", () => {
    expect(upsertSiteDomainRequestSchema.parse({ siteId: "s1", host: "a.com" })).toEqual({
      siteId: "s1",
      host: "a.com",
    });
  });

  it.each([
    ["missing siteId", { host: "a.com" }],
    ["missing host", { siteId: "s1" }],
    ["empty host", { siteId: "s1", host: "" }],
    ["illegal status", { siteId: "s1", host: "a.com", status: "paused" }],
    ["empty canonicalHost", { siteId: "s1", host: "a.com", canonicalHost: "" }],
    ["non-boolean isPrimary", { siteId: "s1", host: "a.com", isPrimary: "yes" }],
    ["unknown field rejected by strict", { siteId: "s1", host: "a.com", x: true }],
  ])("rejects %s", (_label, payload) => {
    expect(upsertSiteDomainRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("upsertSiteAppRequestSchema", () => {
  it("accepts a valid payload", () => {
    expect(
      upsertSiteAppRequestSchema.parse({ siteId: "s1", appKey: "web", surface: "general" }),
    ).toEqual({ siteId: "s1", appKey: "web", surface: "general" });
  });

  it.each([
    ["missing surface", { siteId: "s1", appKey: "web" }],
    ["illegal surface", { siteId: "s1", appKey: "web", surface: "mobile" }],
    ["empty appKey", { siteId: "s1", appKey: "", surface: "general" }],
    ["illegal status", { siteId: "s1", appKey: "web", surface: "general", status: "off" }],
    ["empty defaultRoute", { siteId: "s1", appKey: "web", surface: "general", defaultRoute: "" }],
    ["unknown field rejected by strict", { siteId: "s1", appKey: "web", surface: "general", y: 1 }],
  ])("rejects %s", (_label, payload) => {
    expect(upsertSiteAppRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("upsertSitePolicyRequestSchema", () => {
  it("accepts a valid payload with object value", () => {
    const parsed = upsertSitePolicyRequestSchema.parse({
      siteId: "s1",
      key: "rate-limit",
      value: { rpm: 60, allow: [null, "x"] },
    });
    expect(parsed.value).toEqual({ rpm: 60, allow: [null, "x"] });
  });

  it.each([
    ["missing value", { siteId: "s1", key: "k" }],
    ["non-object value (string)", { siteId: "s1", key: "k", value: "x" }],
    ["non-object value (array)", { siteId: "s1", key: "k", value: [1, 2] }],
    ["missing key", { siteId: "s1", value: {} }],
    ["illegal status", { siteId: "s1", key: "k", value: {}, status: "archived" }],
    ["unknown field rejected by strict", { siteId: "s1", key: "k", value: {}, z: 1 }],
  ])("rejects %s", (_label, payload) => {
    expect(upsertSitePolicyRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("upsertSiteFeatureFlagRequestSchema", () => {
  it("accepts a minimal valid payload", () => {
    expect(
      upsertSiteFeatureFlagRequestSchema.parse({ siteId: "s1", key: "video", enabled: true }),
    ).toEqual({ siteId: "s1", key: "video", enabled: true });
  });

  it("accepts a payload with JSON metadata", () => {
    const parsed = upsertSiteFeatureFlagRequestSchema.parse({
      siteId: "s1",
      key: "video",
      enabled: false,
      metadata: { rolloutPct: 25, cohorts: ["beta", null] },
    });
    expect(parsed.metadata).toEqual({ rolloutPct: 25, cohorts: ["beta", null] });
  });

  it.each([
    ["missing siteId", { key: "video", enabled: true }],
    ["missing key", { siteId: "s1", enabled: true }],
    ["missing enabled", { siteId: "s1", key: "video" }],
    ["empty key", { siteId: "s1", key: "", enabled: true }],
    ["non-boolean enabled", { siteId: "s1", key: "video", enabled: "yes" }],
    ["non-object metadata", { siteId: "s1", key: "video", enabled: true, metadata: [1] }],
    ["unknown field rejected by strict", { siteId: "s1", key: "video", enabled: true, x: 1 }],
  ])("rejects %s", (_label, payload) => {
    expect(upsertSiteFeatureFlagRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("listSiteFeatureFlagsQuerySchema", () => {
  it("accepts a siteId", () => {
    expect(listSiteFeatureFlagsQuerySchema.parse({ siteId: "s1" })).toEqual({ siteId: "s1" });
  });

  it.each([
    ["missing siteId", {}],
    ["empty siteId", { siteId: "" }],
    ["unknown field rejected by strict", { siteId: "s1", extra: 1 }],
  ])("rejects %s", (_label, payload) => {
    expect(listSiteFeatureFlagsQuerySchema.safeParse(payload).success).toBe(false);
  });
});

describe("resolveSiteQuerySchema", () => {
  it("accepts host only and full triple", () => {
    expect(resolveSiteQuerySchema.parse({ host: "a.com" })).toEqual({ host: "a.com" });
    expect(resolveSiteQuerySchema.parse({ host: "a.com", appKey: "web", surface: "studio" })).toEqual({
      host: "a.com",
      appKey: "web",
      surface: "studio",
    });
  });

  it.each([
    ["missing host", { appKey: "web" }],
    ["empty host", { host: "" }],
    ["empty appKey", { host: "a.com", appKey: "" }],
    ["illegal surface", { host: "a.com", surface: "tv" }],
    ["unknown field rejected by strict", { host: "a.com", extra: "1" }],
  ])("rejects %s", (_label, payload) => {
    expect(resolveSiteQuerySchema.safeParse(payload).success).toBe(false);
  });
});
