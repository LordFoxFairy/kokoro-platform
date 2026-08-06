import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("fresh-only scoped authorization provider", () => {
  it("mounts only the v2 feed service in production", async () => {
    const composition = await readFile("src/process/session-authorization-composition.ts", "utf8");
    expect(composition).toContain("ScopedSessionAuthorizationService");
    expect(composition).toContain("createScopedSessionAuthorizationFeedService");
    expect(composition).toContain("generated/proto/kokoro/platform/authorization/v2");
    expect(composition).not.toContain("generated/proto/kokoro/platform/authorization/v1");
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

  it("grants the authorization runtime every owner read used by snapshot materialization", async () => {
    const [repository, client, migrator, lockMigration] = await Promise.all([
      readFile(
        "src/modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.ts",
        "utf8",
      ),
      readFile("src/infrastructure/postgres/client.ts", "utf8"),
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
      readFile(
        "prisma/migrations/20260823_authorization_snapshot_lock_authority/migration.sql",
        "utf8",
      ).catch(() => ""),
    ]);
    expect(repository).toContain("JOIN platform.authorization_project project");
    expect(repository).not.toMatch(/\) grant ON TRUE/u);
    expect(repository.match(/\) delivered_grant ON TRUE/gu)).toHaveLength(4);
    expect(repository).toContain("platform.lock_authorization_snapshot_watermark()");
    expect(repository).not.toMatch(/authorization_scoped_stream_state[^`]*FOR SHARE/u);
    expect(lockMigration).toContain("SECURITY DEFINER SET search_path=pg_catalog,platform");
    expect(lockMigration).toContain("current_setting('app.workload_kind',true)<>'platform_authorization'");
    expect(lockMigration).toContain("current_setting('app.operation',true)<>'authorization.snapshot.create'");
    expect(lockMigration).toContain(
      "REVOKE ALL ON FUNCTION platform.lock_authorization_snapshot_watermark() FROM PUBLIC",
    );

    const grantBranchStart = migrator.indexOf("} else if (role === authorizationRole) {");
    const grantBranch = migrator.slice(grantBranchStart, migrator.indexOf("} else {", grantBranchStart));
    expect(grantBranch).toContain("platform.authorization_project,");
    expect(grantBranch).toContain(
      "GRANT EXECUTE ON FUNCTION platform.lock_authorization_snapshot_watermark()",
    );

    const runtimeRequiredStart = client.indexOf("WHEN $2 = 'authorization' THEN");
    const runtimeRequired = client.slice(runtimeRequiredStart, runtimeRequiredStart + 2_500);
    expect(runtimeRequired).toContain(
      "has_table_privilege(current_user, 'platform.authorization_project', 'SELECT')",
    );
    expect(runtimeRequired).toContain(
      "has_function_privilege(current_user, 'platform.lock_authorization_snapshot_watermark()', 'EXECUTE')",
    );
    const runtimeAllowanceStart = client.indexOf("($2 = 'authorization' AND (");
    const runtimeAllowance = client.slice(runtimeAllowanceStart, runtimeAllowanceStart + 1_500);
    expect(runtimeAllowance).toContain("'authorization_project',");
    expect(client).toMatch(
      /\(\$2 = 'authorization' AND candidate_function\.oid =\s*to_regprocedure\('platform\.lock_authorization_snapshot_watermark\(\)'\)\)/u,
    );

    const migrationRequiredStart = migrator.indexOf("WHEN runtime_role.rolname = $2 THEN");
    const migrationRequired = migrator.slice(migrationRequiredStart, migrationRequiredStart + 2_500);
    expect(migrationRequired).toContain(
      "has_table_privilege(runtime_role.rolname, 'platform.authorization_project', 'SELECT')",
    );
    expect(migrationRequired).toContain(
      "has_function_privilege(runtime_role.rolname, " +
      "'platform.lock_authorization_snapshot_watermark()', 'EXECUTE')",
    );
    const migrationAllowanceStart = migrator.indexOf("(runtime_role.rolname = $2 AND (");
    const migrationAllowance = migrator.slice(migrationAllowanceStart, migrationAllowanceStart + 1_500);
    expect(migrationAllowance).toContain("'authorization_project',");
    expect(migrator).toMatch(
      /\(runtime_role\.rolname = \$2 AND candidate_function\.oid =\s*to_regprocedure\('platform\.lock_authorization_snapshot_watermark\(\)'\)\)/u,
    );
  });
});
