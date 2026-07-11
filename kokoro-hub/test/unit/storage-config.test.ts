import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHubStoreLocation } from "../../src/config/storage.js";

function writeYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-storage-"));
  const path = join(dir, "storage.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadHubStoreLocation (ADR-009 yaml, hub node)", () => {
  it("returns null when no config path is given (upload surface unconfigured)", () => {
    expect(loadHubStoreLocation(undefined)).toBeNull();
    expect(loadHubStoreLocation("")).toBeNull();
  });

  it("returns null when the yaml has no hub node", () => {
    const path = writeYaml("workspace:\n  type: local\n  root: /data/ws\n");
    expect(loadHubStoreLocation(path)).toBeNull();
  });

  it("parses a local hub node", () => {
    const path = writeYaml(
      "workspace:\n  type: local\n  root: /data/ws\nhub:\n  type: local\n  root: /data/hub\n",
    );
    expect(loadHubStoreLocation(path)).toEqual({ type: "local", root: "/data/hub" });
  });

  it("parses an s3 hub node with defaults and tolerates the deliveries node", () => {
    const path = writeYaml(
      [
        "workspace:",
        "  type: local",
        "  root: /data/ws",
        "hub:",
        "  type: s3",
        "  endpoint: http://127.0.0.1:9100",
        "  bucket: kokoro-hub",
        "deliveries:",
        "  type: local",
        "  root: /data/deliveries",
        "",
      ].join("\n"),
    );
    expect(loadHubStoreLocation(path)).toEqual({
      type: "s3",
      endpoint: "http://127.0.0.1:9100",
      bucket: "kokoro-hub",
      region: "us-east-1",
      force_path_style: true,
    });
  });

  it("fails loud on unknown nodes (strict declaration)", () => {
    const path = writeYaml(
      "workspace:\n  type: local\n  root: /data/ws\nmystery:\n  type: local\n  root: /x\n",
    );
    expect(() => loadHubStoreLocation(path)).toThrow();
  });

  it("fails loud on an unknown store type", () => {
    const path = writeYaml("workspace:\n  type: ftp\n  root: /data/ws\n");
    expect(() => loadHubStoreLocation(path)).toThrow();
  });
});
