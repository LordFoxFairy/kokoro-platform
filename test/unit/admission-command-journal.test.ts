import { describe, expect, it } from "vitest";
import type { PlatformInternalOperation } from "../../src/infrastructure/postgres/client.js";
import { PostgresAdmissionCommandJournal } from "../../src/modules/admission/infrastructure/postgres/admission-command-journal.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
  type PlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import type { AdmissionCommandKey } from "../../src/modules/admission/application/admission-ports.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const command: AdmissionCommandKey = {
  identity: "spiffe://kokoro/session",
  environment: "production",
  region: "us-east-1",
  siteId: "site-1",
  operation: "prepare_run",
  commandId: "0198f279-7420-7a32-995f-7f4421eb6c42",
  idempotencyKey: "launch-1:prepare",
  requestDigest: "a".repeat(64),
};

interface Row {
  command: AdmissionCommandKey;
  recordedAt: string;
  state: "processing" | "completed";
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  responsePayload: Uint8Array | null;
  responseDigest: string | null;
}

class FakeAdmissionDatabase implements PlatformSqlTransaction {
  row?: Row;
  scope?: { siteId: string; identity: string };
  clock = now;

  async internalTransaction<Result>(
    operation: PlatformInternalOperation,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result> {
    expect(operation).toBe("admission.command");
    const lease = issuePlatformTransaction(this);
    try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
  }

  async query<Result extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Result[]> {
    if (statement.includes("set_config('app.site_id'")) {
      this.scope = { siteId: String(values[0]), identity: String(values[1]) };
      return [];
    }
    if (!statement.includes("FROM platform.admission_command")) throw new Error("unexpected query");
    const row = this.row;
    if (row === undefined || this.scope?.siteId !== row.command.siteId || this.scope.identity !== row.command.identity) return [];
    return [{
      siteId: row.command.siteId,
      operation: row.command.operation,
      commandId: row.command.commandId,
      environment: row.command.environment,
      region: row.command.region,
      callerIdentity: row.command.identity,
      idempotencyKey: row.command.idempotencyKey,
      requestDigest: row.command.requestDigest,
      state: row.state,
      leaseToken: row.leaseToken,
      leaseExpired: row.leaseExpiresAt !== null && Date.parse(row.leaseExpiresAt) <= this.clock.getTime(),
      responsePayload: row.responsePayload,
      responseDigest: row.responseDigest,
      recordedAt: row.recordedAt,
      leaseExpiresAt: row.leaseExpiresAt,
    } as unknown as Result];
  }

  async execute(statement: string, values: readonly unknown[] = []): Promise<number> {
    if (statement.startsWith("INSERT INTO platform.admission_command")) {
      if (this.row !== undefined) return 0;
      this.row = {
        command: {
          siteId: String(values[0]), operation: String(values[1]) as AdmissionCommandKey["operation"],
          commandId: String(values[2]), environment: String(values[3]), region: String(values[4]),
          identity: String(values[5]), idempotencyKey: String(values[6]), requestDigest: String(values[7]),
        },
        recordedAt: this.clock.toISOString(),
        state: "processing",
        leaseToken: String(values[8]),
        leaseExpiresAt: String(values[9]),
        responsePayload: null,
        responseDigest: null,
      };
      return 1;
    }
    if (statement.includes("SET lease_expires_at=LEAST")) {
      if (this.row?.state !== "processing" || this.row.leaseToken !== values[6]) return 0;
      const current = Date.parse(this.row.leaseExpiresAt ?? "");
      const requested = Date.parse(String(values[0]));
      this.row.leaseExpiresAt = new Date(Math.min(current, requested)).toISOString();
      return 1;
    }
    if (statement.includes("SET state='completed'")) {
      if (this.row?.state !== "processing" || this.row.leaseToken !== values[7]) return 0;
      this.row.state = "completed";
      this.row.responsePayload = new Uint8Array(values[0] as Uint8Array);
      this.row.responseDigest = String(values[1]);
      this.row.leaseToken = null;
      this.row.leaseExpiresAt = null;
      return 1;
    }
    if (statement.includes("SET lease_token=")) {
      if (this.row?.state !== "processing") return 0;
      this.row.leaseToken = String(values[0]);
      this.row.leaseExpiresAt = String(values[1]);
      return 1;
    }
    throw new Error("unexpected execute");
  }
}

describe("Postgres Admission command journal", () => {
  it("fences a command lease, persists exact response bytes and replays without re-execution", async () => {
    const database = new FakeAdmissionDatabase();
    const journal = new PostgresAdmissionCommandJournal(database, { clock: () => now });

    const started = await journal.begin(command);
    expect(started.kind).toBe("started");
    const response = new Uint8Array([1, 2, 3, 4]);
    const completed = await journal.complete(
      command,
      started.kind === "started" ? started.leaseToken : "invalid",
      response,
    );
    response[0] = 99;

    const replay = await journal.begin(command);
    const lookup = await journal.lookup(command);
    expect(completed).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(replay).toEqual({ kind: "replay", response: new Uint8Array([1, 2, 3, 4]) });
    expect(lookup).toEqual({ kind: "found", response: new Uint8Array([1, 2, 3, 4]) });
  });

  it("rejects idempotency-key reuse with a different command digest", async () => {
    const database = new FakeAdmissionDatabase();
    const journal = new PostgresAdmissionCommandJournal(database, { clock: () => now });
    await journal.begin(command);

    await expect(journal.begin({ ...command, requestDigest: "b".repeat(64) })).rejects.toThrow(
      "ADMISSION_COMMAND_CONFLICT",
    );
  });

  it("reclaims an explicit pending decision only at retry time and fences the stale lease", async () => {
    const database = new FakeAdmissionDatabase();
    const journal = new PostgresAdmissionCommandJournal(database, { clock: () => database.clock });
    const first = await journal.begin(command);
    expect(first.kind).toBe("started");

    const retryAt = "2026-07-29T12:00:01.000Z";
    expect(await journal.defer(
      command,
      first.kind === "started" ? first.leaseToken : "invalid",
      retryAt,
    )).toBe(retryAt);
    expect(await journal.begin(command)).toEqual({
      kind: "pending",
      recordedAt: now.toISOString(),
      retryAt,
    });
    expect(await journal.lookup(command)).toEqual({
      kind: "pending",
      idempotencyKey: command.idempotencyKey,
      recordedAt: now.toISOString(),
      retryAt,
    });
    database.clock = new Date(retryAt);
    const second = await journal.begin(command);

    expect(second.kind).toBe("started");
    await expect(journal.defer(
      command,
      first.kind === "started" ? first.leaseToken : "invalid",
      "2026-07-29T12:00:02.000Z",
    )).rejects.toThrow("ADMISSION_COMMAND_LEASE_LOST");
    await expect(journal.complete(
      command,
      first.kind === "started" ? first.leaseToken : "invalid",
      new Uint8Array([1]),
    )).rejects.toThrow("ADMISSION_COMMAND_LEASE_LOST");
    const terminal = new Uint8Array([9, 8, 7]);
    await journal.complete(
      command,
      second.kind === "started" ? second.leaseToken : "invalid",
      terminal,
    );
    expect(await journal.begin(command)).toEqual({ kind: "replay", response: terminal });
    expect(await journal.lookup(command)).toEqual({ kind: "found", response: terminal });
  });

  it("caps owner retry hints at the original command lease and exposes that authority", async () => {
    const database = new FakeAdmissionDatabase();
    const journal = new PostgresAdmissionCommandJournal(database, {
      clock: () => database.clock,
      leaseMs: 30_000,
    });
    const first = await journal.begin(command);
    expect(first.kind).toBe("started");

    const effectiveRetryAt = await journal.defer(
      command,
      first.kind === "started" ? first.leaseToken : "invalid",
      "2099-01-01T00:00:00.000Z",
    );

    expect(effectiveRetryAt).toBe("2026-07-29T12:00:30.000Z");
    expect(await journal.begin(command)).toEqual({
      kind: "pending",
      recordedAt: now.toISOString(),
      retryAt: effectiveRetryAt,
    });
    database.clock = new Date(effectiveRetryAt);
    expect((await journal.begin(command)).kind).toBe("started");
  });
});
