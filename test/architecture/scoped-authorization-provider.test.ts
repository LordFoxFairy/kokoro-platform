import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("fresh-only scoped authorization provider", () => {
  it("mounts only the v2 feed service in production", async () => {
    const composition = await readFile("src/process/session-authorization-composition.ts", "utf8");
    expect(composition).toContain("ScopedSessionAuthorizationService");
    expect(composition).toContain("createScopedSessionAuthorizationFeedService");
    expect(composition).not.toContain("generated-authorization/kokoro/platform/authorization/v1");
    expect(composition).toContain("PLATFORM_AUTHORIZATION_SESSION_SPIFFE_ID");
    expect(composition).toContain("peers.some((peer) => peer.sanUri !== expectedSessionSpiffeId)");
  });

  it("freezes immutable v2 snapshots and revokes public access", async () => {
    const migration = await readFile("prisma/migrations/20260729_scoped_authorization_feed/migration.sql", "utf8");
    expect(migration).toContain("authorization_scoped_snapshot");
    expect(migration).toContain("authorization_scoped_snapshot_record");
    expect(migration).toContain("authorization_scoped_snapshot_immutable");
    expect(migration).toMatch(/REVOKE ALL ON[\s\S]*authorization_scoped_snapshot[\s\S]*FROM PUBLIC/u);
  });
});
