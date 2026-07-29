import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PostgresAdmissionCapabilityOwner,
  PostgresAdmissionRuntimePolicyOwner,
} from "../../src/modules/admission/infrastructure/postgres/admission-runtime-owners.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

class OwnerSql implements PlatformSqlTransaction {
  rows: Record<string, unknown>[] = [];
  statements: string[] = [];
  async query<Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    return this.rows as Row[];
  }
  async execute(): Promise<number> { throw new Error("read only"); }
}

const permissions = Object.freeze({
  approval_tools: ["shell"],
  review_tools: ["web_fetch"],
  subagent_create: "ask",
  filesystem: "workspace_write",
});

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

describe("Postgres Admission immutable runtime owners", () => {
  it("resolves a launch profile pinned to the exact active SiteRelease", async () => {
    const sql = new OwnerSql();
    const launch = {
      schemaVersion: 1,
      siteId: "site-a",
      siteReleaseRef: "release-a",
      backend: "e2b",
      permissions,
      billing: {
        unit: "credit_micros", liabilityMerchantAccountRef: "merchant-a",
        ratingPolicyRevisionRef: "rating-a", rootCeiling: "100000", segmentMaximum: "100000",
        surfaceRef: "chat", capabilityKey: "chat.general",
      },
    };
    const snapshotDigest = digest(launch);
    sql.rows = [{
      siteId: "site-a", siteReleaseRef: "release-a",
      launchProfileRef: `launch-profile:sha256:${snapshotDigest}`, snapshotDigest, payload: launch,
    }];
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAdmissionRuntimePolicyOwner().resolve(lease.transaction, {
        siteId: "site-a", projectRef: "project-a", configurationRevisionId: "release-a",
      })).resolves.toEqual({ kind: "resolved", value: { backend: "e2b", permissions } });
      expect(sql.statements[0]).toContain("release.launch_profile_ref=profile.launch_profile_ref");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("resolves only allowlisted immutable capability choices and returns a deterministic snapshot", async () => {
    const payload = {
      schemaVersion: 1,
      agentOptions: [{ optionRef: "agent:general", agent: "general-v3", label: "General" }],
      defaultAgentOptionRef: "agent:general",
      tools: ["deliver", "web_fetch"],
      skillOptions: [{
        optionRef: "skill:research", label: "Research", name: "research",
        contentHash: "a".repeat(64), description: "Research sources", scope: "session",
        prerequisiteRef: "connection:browser",
      }],
      mcpOptions: [{
        optionRef: "mcp:github", label: "GitHub", scope: "session", name: "github",
        revision: 7, configHash: "b".repeat(64), prerequisiteRef: "connection:github",
      }],
      subagents: ["researcher"],
    };
    const snapshotDigest = digest(payload);
    const sql = new OwnerSql();
    sql.rows = [{
      siteId: "site-a", siteReleaseRef: "release-a", agentCatalogRef: "agent-catalog-a",
      snapshotDigest, payload,
    }];
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionCapabilityOwner();
      const input = {
        siteId: "site-a", projectRef: "project-a", configurationRevisionId: "release-a",
        requestedAgentOptionRef: "agent:general",
        requestedSkillOptionRefs: ["skill:research"], requestedMcpOptionRefs: ["mcp:github"],
      };
      const first = await owner.resolve(lease.transaction, input);
      const second = await owner.resolve(lease.transaction, input);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        kind: "resolved",
        value: {
          agent: "general-v3", agentLabel: "General", tools: ["deliver", "web_fetch"],
          skills: [{ name: "research", content_hash: "a".repeat(64), description: "Research sources", scope: "session" }],
          mcpServers: [{ scope: "session", name: "github", revision: 7, config_hash: "b".repeat(64) }],
          subagents: ["researcher"],
          safeCapabilities: [{ kind: "skill", label: "Research" }, { kind: "mcp", label: "GitHub" }],
          prerequisiteRefs: ["connection:browser", "connection:github"],
        },
      });
      expect((first as { value: { capabilitySnapshotRef: string } }).value.capabilitySnapshotRef)
        .toMatch(/^capability-snapshot:sha256:[a-f0-9]{64}$/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("denies missing or unallowlisted profiles and hard-fails corrupt immutable payloads", async () => {
    const sql = new OwnerSql();
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAdmissionRuntimePolicyOwner().resolve(lease.transaction, {
        siteId: "site-a", projectRef: "project-a", configurationRevisionId: "release-a",
      })).resolves.toMatchObject({ kind: "denied", denial: { code: "ADMISSION_LAUNCH_PROFILE_NOT_AVAILABLE" } });

      const payload = {
        schemaVersion: 1, agentOptions: [], defaultAgentOptionRef: "missing",
        tools: [], skillOptions: [], mcpOptions: [], subagents: [],
      };
      sql.rows = [{
        siteId: "site-a", siteReleaseRef: "release-a", agentCatalogRef: "agent-catalog-a",
        snapshotDigest: digest(payload), payload,
      }];
      await expect(new PostgresAdmissionCapabilityOwner().resolve(lease.transaction, {
        siteId: "site-a", projectRef: "project-a", configurationRevisionId: "release-a",
        requestedSkillOptionRefs: [], requestedMcpOptionRefs: [],
      })).rejects.toThrow("ADMISSION_CAPABILITY_OWNER_CORRUPT");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}
