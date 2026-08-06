import { describe, expect, it } from "vitest";
import { PostgresAdmissionExecutionBindingOwner } from "../../src/modules/admission/infrastructure/postgres/admission-execution-binding-owner.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

class BindingSql implements PlatformSqlTransaction {
  space?: Record<string, unknown>;
  binding?: Record<string, unknown>;
  readonly queries: string[] = [];
  async query<Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> {
    this.queries.push(statement);
    const row = statement.includes("identity_execution_space") ? this.space : this.binding;
    return row === undefined ? [] : [row as Row];
  }
  async execute(_statement: string, values: readonly unknown[] = []): Promise<number> {
    if (this.binding !== undefined) return 0;
    this.binding = {
      bindingRef: values[2], namespace: values[3], threadId: values[4],
      capabilitySnapshotRef: values[5], configurationRevisionId: values[6], bindingDigest: values[7],
    };
    return 1;
  }
}

const input = {
  siteId: "site-a", projectRef: "project-a", sessionId: "session-a", threadId: "thread-a",
  capabilitySnapshotRef: "capability-a", configurationRevisionId: "release-a",
};
const namespace = "opaque-project-namespace-0000000000000001";

describe("Platform-local Admission execution binding owner", () => {
  it("derives a deterministic binding from active IdentityExecutionSpace without Session namespace input", async () => {
    const sql = new BindingSql();
    sql.space = {
      siteId: "site-a", projectRef: "project-a", namespace,
      executionSpaceRef: "execution-space-a", namespaceSecurityEpoch: 1n,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionExecutionBindingOwner();
      const first = await owner.resolve(lease.transaction, input);
      const second = await owner.resolve(lease.transaction, input);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        kind: "resolved",
        value: {
          namespace,
          sessionExecutionBindingRef: expect.stringMatching(/^session-execution-binding:sha256:[a-f0-9]{64}$/u),
        },
      });
      expect(sql.queries).toHaveLength(4);
      for (const statement of sql.queries) {
        expect(statement).not.toMatch(
          /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
        );
      }
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("denies a not-yet-applied namespace and an immutable binding conflict", async () => {
    const sql = new BindingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionExecutionBindingOwner();
      await expect(owner.resolve(lease.transaction, input)).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_EXECUTION_SPACE_NOT_READY" },
      });
      sql.space = {
        siteId: "site-a", projectRef: "project-a", namespace,
        executionSpaceRef: "execution-space-a", namespaceSecurityEpoch: 1n,
      };
      sql.binding = {
        bindingRef: "different", namespace, threadId: "other-thread",
        capabilitySnapshotRef: "capability-a", configurationRevisionId: "release-a",
        bindingDigest: "f".repeat(64),
      };
      await expect(owner.resolve(lease.transaction, input)).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_SESSION_BINDING_CONFLICT" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed when the execution-space security epoch rotates", async () => {
    const sql = new BindingSql();
    sql.space = {
      siteId: "site-a", projectRef: "project-a", namespace,
      executionSpaceRef: "execution-space-a", namespaceSecurityEpoch: 1n,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionExecutionBindingOwner();
      await expect(owner.resolve(lease.transaction, input)).resolves.toMatchObject({ kind: "resolved" });
      sql.space = { ...sql.space, namespaceSecurityEpoch: 2n };
      await expect(owner.resolve(lease.transaction, input)).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_SESSION_BINDING_CONFLICT" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
