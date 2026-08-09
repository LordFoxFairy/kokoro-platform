import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PackageStoreError } from "../../src/domain/errors.js";
import { LocalPackageStore } from "../../src/infrastructure/packages/local-package-store.js";
import { makePackageStore } from "../../src/infrastructure/packages/package-store.js";

function makeStore(): LocalPackageStore {
  return new LocalPackageStore(mkdtempSync(join(tmpdir(), "hub-pkg-")));
}

describe("LocalPackageStore (semantics aligned with agent hub.py LocalPackageStore)", () => {
  it("roundtrips a package", async () => {
    const store = makeStore();
    await store.put("skills/ns/writer/abc.zip", Buffer.from("payload"));
    expect((await store.get("skills/ns/writer/abc.zip")).toString()).toBe("payload");
  });

  it("is idempotent per ref: the first content wins, never overwritten", async () => {
    const store = makeStore();
    await store.put("skills/ns/writer/abc.zip", Buffer.from("payload"));
    await store.put("skills/ns/writer/abc.zip", Buffer.from("ignored"));
    expect((await store.get("skills/ns/writer/abc.zip")).toString()).toBe("payload");
  });

  it("fails loud on a missing ref", async () => {
    const store = makeStore();
    await expect(store.get("skills/ns/writer/missing.zip")).rejects.toThrowError(PackageStoreError);
  });

  it("rejects unsafe refs (defense-in-depth against traversal)", async () => {
    const store = makeStore();
    await expect(store.put("../escape.zip", Buffer.from("x"))).rejects.toThrowError(/unsafe/);
    await expect(store.get("/abs.zip")).rejects.toThrowError(/unsafe/);
  });

  it("does not read an artifact after its request is canceled", async () => {
    const store = makeStore();
    const ref = "skills/ns/writer/abc.zip";
    await store.put(ref, Buffer.from("payload"));
    const controller = new AbortController();
    controller.abort(new DOMException("request canceled", "AbortError"));

    await expect(store.get(ref, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("makePackageStore", () => {
  it("builds a local store from a local location", () => {
    const store = makePackageStore(
      { type: "local", root: mkdtempSync(join(tmpdir(), "hub-pkg-")) },
      null,
    );
    expect(store).toBeInstanceOf(LocalPackageStore);
  });

  it("fails loud for s3 without credentials (env-only, ADR-010)", () => {
    expect(() =>
      makePackageStore(
        {
          type: "s3",
          endpoint: "http://127.0.0.1:9100",
          bucket: "kokoro-hub",
          region: "us-east-1",
          force_path_style: true,
        },
        null,
      ),
    ).toThrowError(/requires credentials/);
  });
});
