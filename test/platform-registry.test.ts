import { describe, expect, it } from "vitest";
import {
  assertPlatformRegistryIntegrity,
  getPlatformModule,
  listActivePlatformModules,
  listPlatformModules,
} from "../src/index.js";

describe("platform module registry", () => {
  it("keeps module ids and directories unique", () => {
    expect(() => assertPlatformRegistryIntegrity()).not.toThrow();
  });

  it("registers implemented platform business modules as active", () => {
    expect(listActivePlatformModules().map((module) => module.id)).toEqual([
      "user",
      "model",
      "credit",
      "payment",
    ]);
  });

  it("declares platform modules and keeps litellm external", () => {
    expect(listPlatformModules().map((module) => module.id)).toEqual([
      "user",
      "model",
      "credit",
      "payment",
      "litellm",
    ]);

    expect(getPlatformModule("credit")).toMatchObject({
      status: "active",
      storage: {
        primary: "mysql",
        databaseEnv: "DATABASE_URL_CREDIT",
      },
    });
  });
});
