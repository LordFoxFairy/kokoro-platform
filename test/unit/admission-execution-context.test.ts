import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpaqueExecutionContextIntentSchema } from "../../src/interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import { mapOpaqueExecutionContextIntent } from "../../src/modules/admission/interfaces/connect/opaque-execution-context.js";
import {
  GaRunRequestDraftFactory,
  type GaRunRequestDraftSealInput,
  type GaRunRequestDraftSealer,
  type SealedGaRunRequestDraft,
  type VerifiedGaRunRequestOwnerFacts,
} from "../../src/modules/admission/application/ga-run-request-draft-factory.js";
import { createAdmissionApplicationComposition } from "../../src/process/admission-composition.js";

const digest = "a".repeat(64);
const audience = "kokoro-session-dispatch";
const now = new Date("2026-07-29T12:00:00.000Z");

const ownerFacts: VerifiedGaRunRequestOwnerFacts = {
  kind: "run.request",
  run_id: "run-1",
  thread_id: "thread-1",
  input: { message_id: "message-1", content: "hello" },
  runtime: {
    agent_type: "general",
    model: { provider: "anthropic", name: "claude-sonnet" },
    tools: [],
    skills: [],
    mcp_servers: [],
    subagents: [],
    backend: "state",
    permissions: {
      approval_tools: [],
      review_tools: [],
      subagent_create: "deny",
      filesystem: "read_only",
    },
  },
  context: { namespace: "namespace-1", session_id: "session-1" },
};

function validSealed(
  input: GaRunRequestDraftSealInput,
  override: Partial<SealedGaRunRequestDraft> = {},
): SealedGaRunRequestDraft {
  return {
    ciphertext: new Uint8Array(32).fill(1),
    encryptionAlgorithm: "HPKE-v1",
    keyRevisionRef: "key-revision-1",
    audience: input.audience,
    expiresAt: "2026-07-29T12:01:00.000Z",
    plaintextSha256: input.plaintextSha256,
    ...override,
  };
}

function factory(seal: GaRunRequestDraftSealer["seal"]): GaRunRequestDraftFactory {
  return new GaRunRequestDraftFactory({
    sealer: { seal },
    expectedAudience: audience,
    clock: () => now,
  });
}

describe("Admission execution-context boundary", () => {
  it.each([
    [{ case: "root" as const, value: true }, { mode: "root" as const }],
    [
      { case: "continueFrom" as const, value: { anchor: "anchor-1", digest } },
      { mode: "continue" as const, parent_anchor: "anchor-1", parent_digest: digest },
    ],
    [
      { case: "forkFrom" as const, value: { anchor: "anchor-1", digest } },
      { mode: "fork" as const, parent_anchor: "anchor-1", parent_digest: digest },
    ],
  ])("maps the %s proto arm to the strict GA intent", (mode, expected) => {
    const wire = create(OpaqueExecutionContextIntentSchema, { mode });

    expect(mapOpaqueExecutionContextIntent(wire)).toEqual(expected);
  });

  it.each([
    { case: "root" as const, value: false },
    { case: "continueFrom" as const, value: { anchor: " anchor-1", digest } },
    { case: "forkFrom" as const, value: { anchor: "anchor-1", digest: "not-a-digest" } },
    { case: "continueFrom" as const, value: { anchor: "a".repeat(257), digest } },
    { case: undefined, value: undefined },
  ])("fails closed for a malformed proto arm %#", (mode) => {
    const wire = create(OpaqueExecutionContextIntentSchema, { mode });

    expect(() => mapOpaqueExecutionContextIntent(wire)).toThrow(
      "ADMISSION_EXECUTION_CONTEXT_INVALID",
    );
  });

  it("canonicalizes and hashes the complete request before asking the sealer to encrypt", async () => {
    const seal = vi
      .fn<GaRunRequestDraftSealer["seal"]>()
      .mockImplementation(async (input) => validSealed(input));

    const sealed = await factory(seal).create({
      ownerFacts: { ...ownerFacts, trace: { z: 1, a: { y: true, x: "value" } } },
      executionContext: { mode: "root" },
    });

    expect(sealed.plaintextSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(seal).toHaveBeenCalledOnce();
    const [sealInput] = seal.mock.calls[0]!;
    const plaintext = new TextDecoder().decode(sealInput.plaintext);
    expect(JSON.parse(plaintext)).toEqual({
      ...ownerFacts,
      execution_context: { mode: "root" },
      trace: { a: { x: "value", y: true }, z: 1 },
    });
    expect(sealInput.plaintextSha256).toBe(
      createHash("sha256").update(sealInput.plaintext).digest("hex"),
    );
    expect(sealInput.audience).toBe(audience);
    expect(sealInput.maximumExpiresAt).toBe("2026-07-29T12:05:00.000Z");
  });

  it("never invokes the sealer for an invalid or non-JSON request draft", async () => {
    const seal = vi.fn<GaRunRequestDraftSealer["seal"]>();
    const createDraft = factory(seal);

    await expect(
      createDraft.create({
        ownerFacts: { ...ownerFacts, thread_id: "" } as VerifiedGaRunRequestOwnerFacts,
        executionContext: { mode: "root" },
      }),
    ).rejects.toThrow();
    await expect(
      createDraft.create({
        ownerFacts: {
          ...ownerFacts,
          trace: { unsafe: new Date("2026-07-29T12:00:00.000Z") },
        },
        executionContext: { mode: "root" },
      }),
    ).rejects.toThrow("ADMISSION_GA_DRAFT_PLAINTEXT_INVALID");
    expect(seal).not.toHaveBeenCalled();
  });

  it.each([
    [
      "short ciphertext",
      (input: GaRunRequestDraftSealInput) => validSealed(input, { ciphertext: new Uint8Array(31) }),
    ],
    [
      "oversized ciphertext",
      (input: GaRunRequestDraftSealInput) =>
        validSealed(input, { ciphertext: new Uint8Array(1024 * 1024 + 1) }),
    ],
    [
      "wrong digest",
      (input: GaRunRequestDraftSealInput) =>
        validSealed(input, { plaintextSha256: "c".repeat(64) }),
    ],
    [
      "wrong audience",
      (input: GaRunRequestDraftSealInput) => validSealed(input, { audience: "another-worker" }),
    ],
    [
      "noncanonical expiry",
      (input: GaRunRequestDraftSealInput) =>
        validSealed(input, { expiresAt: "2026-07-29T12:01:00Z" }),
    ],
    [
      "expired material",
      (input: GaRunRequestDraftSealInput) =>
        validSealed(input, { expiresAt: "2026-07-29T12:00:00.000Z" }),
    ],
    [
      "excessive lifetime",
      (input: GaRunRequestDraftSealInput) =>
        validSealed(input, { expiresAt: "2026-07-29T12:05:00.001Z" }),
    ],
    [
      "empty algorithm",
      (input: GaRunRequestDraftSealInput) => validSealed(input, { encryptionAlgorithm: "" }),
    ],
    [
      "oversized key reference",
      (input: GaRunRequestDraftSealInput) =>
        validSealed(input, { keyRevisionRef: "k".repeat(257) }),
    ],
    [
      "unknown output field",
      (input: GaRunRequestDraftSealInput) => ({ ...validSealed(input), anchor: "must-not-pass" }),
    ],
  ])("rejects a sealer result with %s", async (_case, maliciousResult) => {
    const seal: GaRunRequestDraftSealer["seal"] = async (input) => maliciousResult(input);

    await expect(
      factory(seal).create({ ownerFacts, executionContext: { mode: "root" } }),
    ).rejects.toThrow("ADMISSION_GA_DRAFT_SEALED_MATERIAL_INVALID");
  });

  it("requires a valid exact dispatch audience at the application composition point", () => {
    const sealer: GaRunRequestDraftSealer = {
      seal: async (input) => validSealed(input),
    };
    expect(() =>
      createAdmissionApplicationComposition({
        gaRunRequestDraftSealer: undefined,
        gaDispatchAudience: audience,
      } as unknown as {
        gaRunRequestDraftSealer: GaRunRequestDraftSealer;
        gaDispatchAudience: string;
      }),
    ).toThrow("ADMISSION_GA_DRAFT_SEALER_REQUIRED");
    expect(() =>
      createAdmissionApplicationComposition({
        gaRunRequestDraftSealer: {},
        gaDispatchAudience: audience,
      } as unknown as {
        gaRunRequestDraftSealer: GaRunRequestDraftSealer;
        gaDispatchAudience: string;
      }),
    ).toThrow("ADMISSION_GA_DRAFT_SEALER_REQUIRED");
    expect(() =>
      createAdmissionApplicationComposition({
        gaRunRequestDraftSealer: sealer,
        gaDispatchAudience: " dispatch ",
      }),
    ).toThrow("ADMISSION_GA_DRAFT_AUDIENCE_INVALID");

    const composition = createAdmissionApplicationComposition({
      gaRunRequestDraftSealer: sealer,
      gaDispatchAudience: audience,
    });
    expect(composition.gaRunRequestDraftFactory).toBeInstanceOf(GaRunRequestDraftFactory);
  });
});
