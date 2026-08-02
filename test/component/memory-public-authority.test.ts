import { createHmac, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import { MemoryPublicOwner, MemoryPublicReadOwner, PostgresMemoryPublicRepository,
  createMemoryReplayRequestVerifier, createMemoryTransitionAuthority, createProtectedMemoryContent,
  memoryPublicPersonalContext,
  type MemoryPublicUnitOfWork } from "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

const bootstrapUrl = required("DATABASE_URL_PLATFORM_BOOTSTRAP_TEST");
const publicUrl = required("DATABASE_URL_PLATFORM_MEMORY_PUBLIC_TEST");

describe("Memory public PostgreSQL authority", () => {
  const suffix = randomUUID();
  const siteRef = `memory-public-site-${suffix}`;
  const otherSiteRef = `memory-public-other-site-${suffix}`;
  const releaseRef = `memory-public-release-${suffix}`;
  const otherReleaseRef = `memory-public-other-release-${suffix}`;
  const subjectRef = `memory-public-subject-${suffix}`;
  const otherSubjectRef = `memory-public-other-subject-${suffix}`;
  const policyRef = `memory-public-policy-${suffix}`;
  const authorityKey = new Uint8Array(32).fill(23);
  const bootstrap = new Client({ connectionString: bootstrapUrl });
  const publicClient = new Client({ connectionString: publicUrl });
  let repository: PostgresMemoryPublicRepository;
  let owner: MemoryPublicOwner;
  let reads: MemoryPublicReadOwner;
  let protectionCalls = 0;
  const context = memoryPublicPersonalContext({ siteRef, subjectRef, subjectGeneration: 1n,
    featurePolicyRevisionRef: policyRef });

  beforeAll(async () => {
    await runPlatformMigrations({ environment: process.env });
    await Promise.all([bootstrap.connect(), publicClient.connect()]);
    await seedSite(bootstrap, siteRef, releaseRef, subjectRef, policyRef);
    await seedSite(bootstrap, otherSiteRef, otherReleaseRef, otherSubjectRef, policyRef);
    await bootstrap.query(
      `INSERT INTO platform.memory_transition_authority_key
         (key_revision,hmac_key,state,created_at)
       VALUES ('memory-transition-r1',$1::bytea,'active',statement_timestamp())`,
      [Buffer.from(authorityKey)],
    );
    repository = new PostgresMemoryPublicRepository(createMemoryTransitionAuthority({
      keyRevision: "memory-transition-r1", key: authorityKey,
    }), createMemoryReplayRequestVerifier({ active: {
      keyRevision: "memory-replay-r1", key: new Uint8Array(32).fill(29),
    } }));
    const unitOfWork = postgresUnitOfWork(publicClient);
    const protector = {
      protect: async () => {
        protectionCalls += 1;
        return createProtectedMemoryContent({ envelopeVersion: 1, keyRevision: "memory-content-r1",
          nonce: new Uint8Array(12).fill(1), ciphertext: new Uint8Array([1, 2, 3]),
          authenticationTag: new Uint8Array(16).fill(2), aadDigest: "a".repeat(64) });
      },
      reveal: async () => new TextEncoder().encode("restored memory"),
    };
    owner = new MemoryPublicOwner({ repository, unitOfWork, protector,
      admission: { admit: async () => ({ kind: "accepted" }) },
      fingerprints: { fingerprint: async (input, requestedRevision) => {
        const keyRevision = requestedRevision ?? "memory-command-r1";
        const digest = createHmac("sha256", Buffer.alloc(32, keyRevision === "memory-command-r1" ? 3 : 4))
          .update(JSON.stringify(input, (_key, value) => typeof value === "bigint" ? value.toString() : value))
          .digest("hex");
        return { keyRevision, digest };
      } },
      clock: monotonicClock(),
    });
    reads = new MemoryPublicReadOwner({ repository, unitOfWork, protector,
      cursors: { encode: () => "unused", decode: () => { throw new Error("unused"); } },
      clock: () => new Date(Date.now() + 3_600_000), reference: () => "snapshot-ref-1" });
  }, 60_000);

  afterAll(async () => {
    try {
      await bootstrap.query("ROLLBACK").catch(() => undefined);
      await bootstrap.query("BEGIN");
      await bootstrap.query("SET LOCAL session_replication_role='replica'");
      for (const candidateSite of [siteRef, otherSiteRef]) {
        await bootstrap.query("DELETE FROM platform.memory_purge_revision_target WHERE site_ref=$1",
          [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_purge_job WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_revision_payload WHERE site_ref=$1",
          [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_provenance WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_command_receipt WHERE site_ref=$1",
          [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_revision WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_entry WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_space WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.memory_public_command_inbox WHERE site_ref=$1",
          [candidateSite]);
        await bootstrap.query("DELETE FROM platform.authorization_subject WHERE site_ref=$1",
          [candidateSite]);
        await bootstrap.query("DELETE FROM platform.authorization_site_release WHERE site_ref=$1",
          [candidateSite]);
        await bootstrap.query("DELETE FROM platform.authorization_site WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.site_release WHERE site_ref=$1", [candidateSite]);
        await bootstrap.query("DELETE FROM platform.site WHERE site_ref=$1", [candidateSite]);
      }
      await bootstrap.query("DELETE FROM platform.memory_transition_authority_key WHERE key_revision=$1",
        ["memory-transition-r1"]);
      await bootstrap.query("COMMIT");
    } catch (error) {
      await bootstrap.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await Promise.allSettled([bootstrap.end(), publicClient.end()]);
    }
  });

  it("pins the public login OID and grants exactly the closed 22-routine authority", async () => {
    const result = await bootstrap.query<{ routine_count: string; relation_count: string;
      oid_current: boolean; schema_usage: boolean }>(
      `SELECT
        (SELECT count(*)::text FROM pg_proc routine CROSS JOIN LATERAL aclexplode(routine.proacl) acl
          WHERE routine.pronamespace=to_regnamespace('platform')
            AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='platform_memory_public')
            AND acl.privilege_type='EXECUTE') AS routine_count,
        (SELECT count(*)::text FROM pg_class relation CROSS JOIN LATERAL aclexplode(relation.relacl) acl
          WHERE relation.relnamespace=to_regnamespace('platform')
            AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='platform_memory_public')) AS relation_count,
        (SELECT identity.role_oid=role_row.oid FROM platform.memory_database_role_identity identity
          JOIN pg_roles role_row ON role_row.rolname=identity.role_name
          WHERE identity.role_kind='public') AS oid_current,
        has_schema_privilege('platform_memory_public','platform','USAGE') AS schema_usage`,
    );
    expect(result.rows).toEqual([{ routine_count: "22", relation_count: "0",
      oid_current: true, schema_usage: true }]);
  });

  it("executes remember/correct/restore/priority and replays before release or KMS drift", async () => {
    const remembered = await owner.remember({ context, commandRef: `remember-a-${suffix}`,
      category: "fact", content: "A durable fact", validFrom: null, validTo: null });
    expect(remembered).toMatchObject({ kind: "entry", revision: 1n, committedSpaceVersion: 2n });
    const entryRef = remembered.entryRef!;
    const firstRevisionRef = remembered.revisionRef!;
    const corrected = await owner.correct({ context, commandRef: `correct-a-${suffix}`, entryRef,
      expectedRevision: 1, content: "A corrected fact", validFrom: null, validTo: null });
    expect(corrected).toMatchObject({ revision: 2n, committedSpaceVersion: 3n });
    const restored = await owner.restore({ context, commandRef: `restore-a-${suffix}`, entryRef,
      revisionRef: firstRevisionRef, expectedRevision: 2 });
    expect(restored).toMatchObject({ kind: "restored", revision: 3n,
      restoredFromRevisionRef: firstRevisionRef, committedSpaceVersion: 4n });
    const prioritized = await owner.setPriority({ context, commandRef: `priority-a-${suffix}`, entryRef,
      expectedEntryVersion: 3n, prioritized: true });
    expect(prioritized).toMatchObject({ prioritized: true, committedSpaceVersion: 5n });

    await bootstrap.query(
      "UPDATE platform.authorization_site_release SET state='revoked' WHERE release_ref=$1",
      [releaseRef],
    );
    const callsBeforeReplay = protectionCalls;
    await expect(owner.restore({ context, commandRef: `restore-a-${suffix}`, entryRef,
      revisionRef: firstRevisionRef, expectedRevision: 2 })).resolves.toMatchObject({
      replayed: true, restoredFromRevisionRef: firstRevisionRef, committedSpaceVersion: 4n,
    });
    expect(protectionCalls).toBe(callsBeforeReplay);
    await expect(owner.remember({ context, commandRef: `release-drift-${suffix}`,
      category: "fact", content: "must fail", validFrom: null, validTo: null })).rejects.toThrow();
    await bootstrap.query(
      "UPDATE platform.authorization_site_release SET state='active' WHERE release_ref=$1",
      [releaseRef],
    );
  });

  it("rejects forged transitions and cross-Site/cross-subject owner claims", async () => {
    const commandRef = `forged-${suffix}`;
    const owner = await bootstrap.query<{ space_ref: string }>(
      "SELECT space_ref FROM platform.memory_space WHERE site_ref=$1 AND subject_ref=$2",
      [siteRef, subjectRef],
    );
    const spaceRef = owner.rows[0]?.space_ref;
    if (spaceRef === undefined) throw new Error("MEMORY_TEST_OWNER_SPACE_MISSING");
    const prepare = await publicClient.query<{ result: Record<string, unknown> }>(
      `SELECT platform.memory_public_prepare_remember($1,$2,1,$3,$4,$5::char(64),$6,
        $7::char(64),$8,$9,$10,$11) AS result`,
      [siteRef, subjectRef, policyRef, commandRef, "b".repeat(64), "memory-command-r1",
        "c".repeat(64), "memory-replay-r1", spaceRef,
        `memory-entry:${"2".repeat(64)}`, `memory-revision:${"3".repeat(64)}`],
    );
    expect(prepare.rows[0]?.result).toMatchObject({ decision: "claimed" });
    await expect(publicClient.query("SELECT platform.memory_public_commit_remember($1::jsonb)",
      [JSON.stringify({ command: { operation: "remember" }, transition: { operation: "remember" },
        prepareRef: "forged", expectedStateDigest: "0".repeat(64), authority: {
          keyRevision: "memory-transition-r1", canonicalPayload: "{}", digest: "0".repeat(64),
        } })])).rejects.toThrow();
    const stored = await bootstrap.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM platform.memory_entry WHERE entry_ref=$1",
      [`memory-entry:${"2".repeat(64)}`],
    );
    expect(stored.rows).toEqual([{ count: "0" }]);

    await expect(publicClient.query(
      `SELECT platform.memory_public_list_entries_owner($1,$2,1,$3,$4,statement_timestamp())`,
      [otherSiteRef, subjectRef, policyRef, spaceRef],
    )).rejects.toThrow();
    await expect(publicClient.query(
      `SELECT platform.memory_public_list_entries_owner($1,$2,1,$3,$4,statement_timestamp())`,
      [siteRef, otherSubjectRef, policyRef, spaceRef],
    )).rejects.toThrow();
  });

  it("forgets only the target, exposes content-free purge evidence, and reset prevents revival", async () => {
    const first = await owner.remember({ context, commandRef: `target-${suffix}`,
      category: "fact", content: "target", validFrom: null, validTo: null });
    const sibling = await owner.remember({ context, commandRef: `sibling-${suffix}`,
      category: "preference", content: "sibling", validFrom: null, validTo: null });
    await owner.forget({ context, commandRef: `forget-${suffix}`, entryRef: first.entryRef!,
      expectedEntryVersion: 1n });
    await expect(reads.get({ context, entryRef: first.entryRef! })).resolves.toMatchObject({
      entry: { state: "revoked_purge_pending", purgeReceiptRef: expect.any(String),
        revokedAt: expect.stringMatching(/\.\d{3}Z$/u) },
    });
    const forgottenHistory = await reads.history({ context, entryRef: first.entryRef! });
    expect(forgottenHistory.items).toEqual([expect.objectContaining({
      revisionRef: first.revisionRef, state: "purged", restorable: false,
    })]);
    expect(forgottenHistory.items[0]).not.toHaveProperty("content");
    await expect(owner.restore({ context, commandRef: `restore-forgotten-${suffix}`,
      entryRef: first.entryRef!, revisionRef: first.revisionRef!, expectedRevision: 1 }))
      .rejects.toThrow();
    await expect(reads.get({ context, entryRef: sibling.entryRef! })).resolves.toMatchObject({
      entry: { state: "active", content: "restored memory" },
    });
    await owner.reset({ context, commandRef: `reset-${suffix}` });
    await expect(reads.get({ context, entryRef: sibling.entryRef! })).resolves.toMatchObject({
      entry: { state: "revoked_purge_pending", purgeReceiptRef: expect.any(String) },
    });
    await expect(reads.list({ context })).resolves.toMatchObject({ items: [] });
    const resetHistory = await reads.history({ context, entryRef: sibling.entryRef! });
    expect(resetHistory.items).toEqual([expect.objectContaining({
      revisionRef: sibling.revisionRef, state: "purged", restorable: false,
    })]);
    expect(resetHistory.items[0]).not.toHaveProperty("content");
    const pendingPayloads = await bootstrap.query<{ payload_count: string }>(
      `SELECT count(*)::text AS payload_count FROM platform.memory_revision_payload payload
       JOIN platform.memory_purge_revision_target target
         ON target.site_ref=payload.site_ref AND target.space_ref=payload.space_ref
        AND target.entry_ref=payload.entry_ref AND target.revision=payload.revision
       WHERE target.site_ref=$1 AND target.purge_job_ref IN (
         SELECT purge_job_ref FROM platform.memory_purge_job WHERE command_ref=$2)`,
      [siteRef, `reset-${suffix}`],
    );
    expect(Number(pendingPayloads.rows[0]?.payload_count ?? "0")).toBeGreaterThan(0);
  });
});

function postgresUnitOfWork(client: Client): MemoryPublicUnitOfWork {
  return Object.freeze({ execute: async <Result>(_fence: Readonly<{ operation: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result> => {
    await client.query("BEGIN");
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) =>
        (await client.query<Row>(sql, values as unknown[])).rows,
      execute: async (sql: string, values: readonly unknown[] = []) =>
        (await client.query(sql, values as unknown[])).rowCount ?? 0,
    });
    try {
      const result = await work(lease.transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      revokePlatformTransaction(lease);
    }
  } });
}

async function seedSite(client: Client, siteRef: string, releaseRef: string, subjectRef: string,
  policyRef: string) {
  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')",
      [siteRef, `memory-${siteRef.includes("other") ? "b" : "a"}-${siteRef.slice(-20)}`.toLowerCase()]);
    await client.query(
    `INSERT INTO platform.site_release(release_ref,site_ref,state,web_artifact_digest,
      release_manifest_digest,certification_digest,launch_profile_ref,site_config_revision_ref,
      legal_revision_ref,feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,
      identity_issuer_label,identity_auth_strength_policy_revision,enabled_surface_ids,locale_policy)
     VALUES ($1,$2,'active',$3,$4,$5,'launch','config','legal',$6,'models','agents','Kokoro',
      'identity-v1','[]'::jsonb,'{}'::jsonb)`,
    [releaseRef, siteRef, "1".repeat(64), "2".repeat(64), "3".repeat(64), policyRef]);
    await client.query("UPDATE platform.site SET state='active',active_release_ref=$2 WHERE site_ref=$1",
      [siteRef, releaseRef]);
    await client.query(
    `INSERT INTO platform.authorization_site(site_ref,state,security_epoch,policy_epoch,revocation_epoch)
     VALUES ($1,'active',1,1,1)`, [siteRef]);
    await client.query(
    `INSERT INTO platform.authorization_site_release(release_ref,site_ref,state,web_artifact_digest,
      enabled_surface_ids,feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,
      identity_issuer_label,identity_auth_strength_policy_revision,locale_policy)
     VALUES ($1,$2,'active',$3,'[]'::jsonb,$4,'models','agents','Kokoro','identity-v1','{}'::jsonb)`,
    [releaseRef, siteRef, "1".repeat(64), policyRef]);
    await client.query(
    `INSERT INTO platform.authorization_subject(subject_ref,site_ref,display_name,state,
      subject_generation,restriction_epoch) VALUES ($1,$2,'Memory subject','active',1,1)`,
    [subjectRef, siteRef]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function monotonicClock() {
  let milliseconds = Date.now() + 60_000;
  return () => new Date(milliseconds += 1_000);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
