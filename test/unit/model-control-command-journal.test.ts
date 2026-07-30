import { describe, expect, it } from "vitest";
import { PostgresModelControlCommandJournal } from "../../src/modules/model-control/infrastructure/postgres/model-control-command-journal.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import {
  createModelControlCommand,
} from "../../src/modules/model-control/application/model-control-command.js";

const security = {
  environment: "production",
  region: "us-east-1",
  callerIdentity: "admin-api",
  callerBindingEpoch: "7",
  actorKind: "operator" as const,
  actorSubjectId: "operator-a",
  actorSubjectGeneration: "3",
};

describe("ModelControl command identity and receipt journal", () => {
  it("preserves the Connect-verified canonical request digest without re-hashing the effect", () => {
    const verifiedRequestDigest = "f".repeat(64);
    const base = createModelControlCommand({
      commandId: "00000000-0000-4000-8000-000000000001",
      requestDigest: verifiedRequestDigest,
      operation: "model.inventory.import",
      security,
      effect: {
        inventoryDigest: "a".repeat(64),
        source: { kind: "platform-native", reference: "catalog#revision=one" },
        providerAvailability: [
          {
            providerKey: "provider-a",
            status: "active",
            health: "healthy",
            epoch: "0",
            observationRef: "health:provider-a",
            observedAt: "2026-07-28T12:00:00.000Z",
          },
        ],
      },
    });
    expect(base.requestDigest).toBe(verifiedRequestDigest);
    expect(createModelControlCommand({
      ...base.input,
      idempotencyKey: "a-different-idempotency-key",
    }).requestDigest).toBe(base.requestDigest);
    expect(
      createModelControlCommand({
        ...base.input,
        effect: {
          ...base.input.effect,
          providerAvailability: [{ ...base.input.effect.providerAvailability[0]!, health: "down" }],
        },
      }).requestDigest,
    ).toBe(verifiedRequestDigest);
    expect(
      createModelControlCommand({
        ...base.input,
        effect: {
          ...base.input.effect,
          inventoryDigest: "c".repeat(64),
        },
      }).requestDigest,
    ).toBe(verifiedRequestDigest);
    expect(
      createModelControlCommand({
        ...base.input,
        security: { ...security, actorSubjectGeneration: "4" },
      }).requestDigest,
    ).toBe(verifiedRequestDigest);
    expect(
      createModelControlCommand({
        ...base.input,
        effect: {
          ...base.input.effect,
          source: { kind: "platform-native", reference: "catalog#revision=two" },
        },
      }).requestDigest,
    ).toBe(verifiedRequestDigest);
    expect(() => createModelControlCommand({ ...base.input, requestDigest: "F".repeat(64) }))
      .toThrow("MODEL_CONTROL_REQUEST_DIGEST_INVALID");
    expect(() => createModelControlCommand({
      ...base.input,
      commandId: "00000000-0000-7000-8000-000000000001",
    })).toThrow("MODEL_CONTROL_COMMAND_ID_INVALID");
  });

  it("records only the immutable command receipt through the caller-owned transaction", async () => {
    const calls: { kind: string; transaction: unknown; value: unknown }[] = [];
    const receipts = {
      begin: async (transaction: unknown, value: unknown) => {
        calls.push({ kind: "begin", transaction, value });
        return value as never;
      },
      recordOutcome: async (transaction: unknown, _identity: unknown, value: unknown) => {
        calls.push({ kind: "outcome", transaction, value });
        return value as never;
      },
    };
    const journal = new PostgresModelControlCommandJournal(receipts);
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      const command = createModelControlCommand({
        commandId: "00000000-0000-4000-8000-000000000004",
        requestDigest: "d".repeat(64),
        operation: "model.inventory.activate",
        security,
        effect: { targetDigest: "d".repeat(64), expectedPointerRevision: "2" },
      });
      await journal.begin(lease.transaction, command);
      await journal.succeed(
        lease.transaction,
        command,
        {
          activationId: command.commandId,
          importId: "00000000-0000-4000-8000-000000000005",
          targetDigest: "d".repeat(64),
          expectedRevision: "2",
          activatedRevision: "3",
          replayed: false,
        },
      );
      expect(calls.map(({ kind }) => kind).sort()).toEqual(["begin", "outcome"]);
      expect(calls.every(({ transaction }) => transaction === lease.transaction)).toBe(true);
      expect(calls.find(({ kind }) => kind === "begin")?.value).toMatchObject({
        idempotencyKey: command.commandId,
      });
      expect(calls.find(({ kind }) => kind === "outcome")?.value).toMatchObject({
        state: "succeeded",
        result: {
          schemaVersion: 1,
          commandId: command.commandId,
          requestDigest: command.requestDigest,
          operation: "model.inventory.activate",
          siteId: null,
          outcome: {
            targetDigest: "d".repeat(64),
            activatedRevision: "3",
          },
        },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
