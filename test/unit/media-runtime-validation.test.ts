import { describe, expect, it } from "vitest";
import { snapshotDenseArray } from "../../src/modules/media/domain/runtime-validation.js";

describe("Media runtime array snapshots", () => {
  it("rejects maximum length before inspecting indexes", () => {
    const oversized = new Array(3);
    let indexReads = 0;
    Object.defineProperty(oversized, 0, { enumerable: true,
      get: () => { indexReads += 1; return "never"; } });
    Object.defineProperty(oversized, 1, { enumerable: true, value: "one" });
    Object.defineProperty(oversized, 2, { enumerable: true, value: "two" });

    expect(() => snapshotDenseArray(oversized, 2, "ARRAY_INVALID", "ARRAY_MAXIMUM_EXCEEDED"))
      .toThrowError(new Error("ARRAY_MAXIMUM_EXCEEDED"));
    expect(indexReads).toBe(0);
  });

  it("rejects Proxy, accessor-length array-likes, and sparse arrays with the exact code", () => {
    let proxyTraps = 0;
    const proxy = new Proxy(["one"], {
      getPrototypeOf: (target) => { proxyTraps += 1; return Reflect.getPrototypeOf(target); },
      ownKeys: (target) => { proxyTraps += 1; return Reflect.ownKeys(target); },
    });
    expect(() => snapshotDenseArray(proxy, 2, "ARRAY_INVALID"))
      .toThrowError(new Error("ARRAY_INVALID"));
    expect(proxyTraps).toBe(0);

    let lengthReads = 0;
    const accessorLength = Object.create(Array.prototype) as Record<string, unknown>;
    Object.defineProperty(accessorLength, "length", { enumerable: false,
      get: () => { lengthReads += 1; return 1; } });
    expect(() => snapshotDenseArray(accessorLength, 2, "ARRAY_INVALID"))
      .toThrowError(new Error("ARRAY_INVALID"));
    expect(lengthReads).toBe(0);

    expect(() => snapshotDenseArray(new Array(1), 2, "ARRAY_INVALID"))
      .toThrowError(new Error("ARRAY_INVALID"));
  });
});
