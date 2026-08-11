import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityCatalogSnapshotDigest } from "@kokoro/hub";
import { canonicalizeModelInventory } from
  "../../src/modules/model-control/domain/model-catalog.js";
import { materializeModelOptionDraftSet } from
  "../../src/modules/model-control/domain/model-option-materialization.js";
import { createSiteReleaseModelCatalogRevision } from
  "../../src/modules/model-control/domain/product-model-option.js";
import { canonicalCertificationPayload, Ed25519SiteReleaseCertificationAuthority } from
  "../../src/modules/site/infrastructure/crypto/site-release-certification-authority.js";
import {
  CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS,
  CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
  CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
  CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL,
  CORE_SINGLE_SITE_BOOTSTRAP_IDENTITY_DELIVERY,
  assertCoreSingleSiteBootstrapSiteProviderConfiguration,
  coreSingleSiteBootstrapReadbackValues,
  coreSingleSiteBootstrapExpectedOwnerFacts,
  coreSingleSiteBootstrapResultDigest,
  coreSingleSiteBootstrapDatabaseEnvironments,
  createCoreSingleSiteBootstrapIdentityOutboxConsumer,
  createCoreSingleSiteBootstrapProductionRecovery,
  createHubCapabilityCatalogPublicationPort,
  createCoreSingleSiteBootstrapRecipe,
  executeCoreSingleSiteBootstrap,
  prepareCoreSingleSiteBootstrapExecution,
  recoverCompletedCoreSingleSiteBootstrap,
  type CoreSingleSiteBootstrapExecution,
  type CoreSingleSiteBootstrapOwners,
  type CoreSingleSiteBootstrapResult,
} from "../../src/process/core-single-site-bootstrap-composition.js";
import { createIdentityAuditDigester } from
  "../../src/modules/identity/infrastructure/crypto/identity-audit-digester.js";
import type { IdentityEffectEventQueue } from
  "../../src/modules/identity/application/services/identity-outbox-consumer.js";
import type { ClaimedOutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import type { CoreBootstrapRecoveryFence } from
  "../../src/infrastructure/postgres/client.js";
import { CatalogProjectionState } from
  "../../src/generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import { CommandDigestAlgorithm, CommandReceiptState } from
  "../../src/generated/proto/kokoro/common/v1/receipt_pb.js";
import {
  coreBootstrapAdminAttestationPayload,
  type CoreBootstrapAdminAttestationBundle,
} from "../../src/process/core-single-site-bootstrap-attestation.js";
import {
  coreSingleSiteBootstrapArguments,
  publishCoreSingleSiteBootstrapOutputs,
  resolveCoreSingleSiteBootstrapCompletion,
} from "../../src/process/core-single-site-bootstrap.js";
import {
  coreBootstrapConfigDigest,
  coreBootstrapUuid,
  type CoreSingleSiteBootstrapDocument,
} from "../../src/process/core-single-site-bootstrap-document.js";
import type { RequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

const NOW = "2026-08-11T01:00:00.000Z";
const ISSUED_AT = "2026-08-11T00:00:00.000Z";
const EXPIRES_AT = "2026-08-12T00:00:00.000Z";
const ADMIN_AUDIENCE = "platform-admin";
const sha = (value: string) => value.repeat(64).slice(0, 64);
const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

describe("core single-Site bootstrap orchestration", () => {
  it("preflights signed authority, then executes the exact owner order and safe readback", async () => {
    const fixture = signedFixture();
    const execution = await prepareCoreSingleSiteBootstrapExecution({
      document: fixture.document,
      secretDigests: { password: sha("1"), redemptionEntropy: sha("2") },
      makerAttestations: fixture.maker.bundle,
      makerPublicKey: fixture.maker.publicKey,
      checkerAttestations: fixture.checker.bundle,
      checkerPublicKey: fixture.checker.publicKey,
      certificationAuthority: fixture.certification.authority,
      now: NOW,
      environment: RUNTIME_ENVIRONMENT,
    });
    const fake = recordingOwners(execution);

    const completed = await executeCoreSingleSiteBootstrap(execution, fake.owners);

    expect(fake.calls).toEqual([
      "configuration.claim",
      "site.register",
      "model.import-inventory",
      "model.activate-inventory",
      "model.materialize-option",
      "site.publish-release",
      "site.request-activation-approval",
      "capability.ensure-empty-catalog",
      "site.approve-and-activate",
      "site.run-outbox-cycle",
      "model.publish-site-catalog",
      "admission.publish-launch-profile",
      "identity.bootstrap-verified-personal",
      "identity.run-outbox-cycle",
      "rating.publish-policy",
      "commerce.publish-credit-program",
      "commerce.publish-offer",
      "commerce.publish-redemption-program",
      "commerce.issue-code-batch",
      "commerce.approve-code-batch",
      "commerce.activate-code-batch",
      "readback.assert-ready",
      "configuration.complete",
    ]);
    expect(completed.redemptionCode).toBe(fake.code);
    expect(completed.result).toMatchObject({
      schemaVersion: 1,
      kind: "kokoro-core-single-site-bootstrap-result",
      bootstrapId: fixture.document.bootstrapId,
      configDigest: execution.configDigest,
      site: {
        siteId: fixture.document.site.siteId,
        siteReleaseRef: fixture.document.site.siteReleaseRef,
        state: "active",
      },
      identity: {
        subjectRef: fixture.document.identity.subjectRef,
        billingAccountRef: fixture.document.identity.billingAccountRef,
      },
      redemption: {
        batchRef: fixture.document.redemption.batchRef,
        safeCodeFingerprint: fake.safeFingerprint,
      },
    });
    expect(JSON.stringify(completed.result)).not.toMatch(/password|redemptionCode|signature/iu);
  });

  it.each(CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS)(
    "replays every committed owner effect once after a crash at %s",
    async (crashStep) => {
      const fixture = signedFixture();
      const execution = await prepareCoreSingleSiteBootstrapExecution({
        document: fixture.document,
        secretDigests: { password: sha("1"), redemptionEntropy: sha("2") },
        makerAttestations: fixture.maker.bundle,
        makerPublicKey: fixture.maker.publicKey,
        checkerAttestations: fixture.checker.bundle,
        checkerPublicKey: fixture.checker.publicKey,
        certificationAuthority: fixture.certification.authority,
        now: NOW,
        environment: RUNTIME_ENVIRONMENT,
      });
      const fake = recordingOwners(execution, crashStep);

      await expect(executeCoreSingleSiteBootstrap(execution, fake.owners))
        .rejects.toThrow(`CRASH_AFTER:${crashStep}`);
      await expect(executeCoreSingleSiteBootstrap(execution, fake.owners)).resolves.toMatchObject({
        result: { configDigest: execution.configDigest },
      });

      expect([...fake.committed].sort()).toEqual([...CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS].sort());
      expect([...fake.commitCounts.values()].every((count) => count === 1)).toBe(true);
    },
  );

  it("rejects configuration or secret drift at the guard without issuing another batch", async () => {
    const fixture = signedFixture();
    const first = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const fake = recordingOwners(first);
    await executeCoreSingleSiteBootstrap(first, fake.owners);
    const issued = fake.commitCounts.get("commerce.issue-code-batch");
    const drifted = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("3") });

    await expect(executeCoreSingleSiteBootstrap(drifted, fake.owners))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
    expect(fake.commitCounts.get("commerce.issue-code-batch")).toBe(issued);
  });

  it("rejects a reconstructed code unless its persisted key, selector, and lookup digest match", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const fake = recordingOwners(execution);
    const owners: CoreSingleSiteBootstrapOwners = {
      ...fake.owners,
      commerce: {
        ...fake.owners.commerce,
        reconstructCode: () => ({
          code: fake.code,
          safeFingerprint: fake.safeFingerprint,
          keyRevision: "code-key-v1",
          batchSelector: "AAAAAAAAAA",
          lookupDigest: sha("8"),
        }),
      },
      readback: {
        assertReady: async () => ({
          deploymentRef: "deployment:core:1",
          code: {
            safeFingerprint: fake.safeFingerprint,
            keyRevision: "code-key-v1",
            batchSelector: "AAAAAAAAAA",
            lookupDigest: sha("9"),
            state: "available",
          },
        }),
      },
    };

    await expect(executeCoreSingleSiteBootstrap(execution, owners)).rejects
      .toThrow("CORE_SINGLE_SITE_BOOTSTRAP_REDEMPTION_READBACK_INVALID");
  });

  it("accepts refreshed signatures for the same operators without changing configuration", async () => {
    const fixture = signedFixture();
    const first = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const fake = recordingOwners(first);
    await executeCoreSingleSiteBootstrap(first, fake.owners);
    const refreshed = refreshAttestations(fixture, "refresh");
    const second = await prepareCoreSingleSiteBootstrapExecution({
      document: fixture.document,
      secretDigests: { password: sha("1"), redemptionEntropy: sha("2") },
      makerAttestations: refreshed.maker,
      makerPublicKey: fixture.maker.publicKey,
      checkerAttestations: refreshed.checker,
      checkerPublicKey: fixture.checker.publicKey,
      certificationAuthority: fixture.certification.authority,
      now: NOW,
      environment: RUNTIME_ENVIRONMENT,
    });

    await executeCoreSingleSiteBootstrap(second, fake.owners);

    expect(second.configDigest).toBe(first.configDigest);
    expect([...fake.commitCounts.values()].every((count) => count === 1)).toBe(true);
  });

  it("recovers a completed safe readback without maker/checker attestations", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const fake = recordingOwners(execution);
    const completed = await executeCoreSingleSiteBootstrap(execution, fake.owners);

    await expect(recoverCompletedCoreSingleSiteBootstrap({
      document: fixture.document,
      secretDigests: execution.secretDigests,
      recovery: { recover: async ({ configDigest }) => {
        expect(configDigest).toBe(execution.configDigest);
        return { result: completed.result, persisted: completed.persisted };
      } },
      reconstructCode: async () => ({
        code: completed.redemptionCode,
        safeFingerprint: completed.result.redemption.safeCodeFingerprint,
        keyRevision: completed.persisted.keyRevision,
        batchSelector: completed.persisted.batchSelector,
        lookupDigest: completed.persisted.lookupDigest,
      }),
    })).resolves.toEqual(completed);
  });

  it("does not treat a pending receipt as completed and still requires fresh authority", async () => {
    const fixture = signedFixture();
    await expect(recoverCompletedCoreSingleSiteBootstrap({
      document: fixture.document,
      secretDigests: { password: sha("1"), redemptionEntropy: sha("2") },
      recovery: { recover: async () => null },
      reconstructCode: async () => { throw new Error("unexpected"); },
    })).resolves.toBeNull();
    await expect(prepareCoreSingleSiteBootstrapExecution({
      ...preflightInput(fixture),
      now: EXPIRES_AT,
    })).rejects.toThrow(/CORE_SINGLE_SITE_BOOTSTRAP|SITE_RELEASE/u);
  });

  it.each([
    ["rating amount", "CREDIT_RATING_POLICY_DECIMAL_INVALID",
      (document: CoreSingleSiteBootstrapDocument) => ({
        ...document,
        rating: { ...document.rating, inputTokenAmount: "1".repeat(39) },
      })],
    ["redemption amount", "COMMERCE_CREDIT_AMOUNT_INVALID",
      (document: CoreSingleSiteBootstrapDocument) => ({
        ...document,
        redemption: { ...document.redemption, amount: "1".repeat(39) },
      })],
  ] as const)("rejects owner-invalid %s during prepare", async (_axis, code, mutate) => {
    const fixture = signedFixture();
    await expect(prepareCoreSingleSiteBootstrapExecution({
      ...preflightInput(fixture),
      document: mutate(fixture.document),
    })).rejects.toThrow(code);
  });

  it("reconstructs a terminal completed code only for exact in-place output verification", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const fake = recordingOwners(execution);
    const completed = await executeCoreSingleSiteBootstrap(execution, fake.owners);
    const persisted = { ...completed.persisted, state: "claimed" as const };
    let reconstructed = 0;

    await expect(recoverCompletedCoreSingleSiteBootstrap({
      document: fixture.document,
      secretDigests: execution.secretDigests,
      recovery: { recover: async () => ({ result: completed.result, persisted }) },
      reconstructCode: async () => {
        reconstructed += 1;
        return {
          code: completed.redemptionCode,
          safeFingerprint: persisted.safeFingerprint,
          keyRevision: persisted.keyRevision,
          batchSelector: persisted.batchSelector,
          lookupDigest: persisted.lookupDigest,
        };
      },
    })).resolves.toEqual({ ...completed, persisted });
    expect(reconstructed).toBe(1);
  });

  it("fails invalid certification or any incomplete/misbound attestation before owner effects", async () => {
    const fixture = signedFixture();
    const cases: Array<Readonly<{ name: string; run(): Promise<unknown> }>> = [
      {
        name: "invalid certification",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          document: {
            ...fixture.document,
            site: {
              ...fixture.document.site,
              releaseCertification: {
                ...fixture.document.site.releaseCertification,
                signature: "A".repeat(86),
              },
            },
          },
        }),
      },
      {
        name: "expired certification",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          now: EXPIRES_AT,
        }),
      },
      {
        name: "missing operation",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          makerAttestations: {
            version: 1,
            attestations: fixture.maker.bundle.attestations.slice(1),
          },
        }),
      },
      {
        name: "wrong subject",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          makerAttestations: signedBundle(
            CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
            "operator:wrong",
            fixture.document,
            fixture.maker.privateKey,
            "wrong-subject",
          ),
        }),
      },
      {
        name: "wrong deployment axis",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          makerAttestations: signedBundle(
            CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
            fixture.document.makerSubjectRef,
            fixture.document,
            fixture.maker.privateKey,
            "wrong-axis",
            { region: "eu-west-1" },
          ),
        }),
      },
      {
        name: "unapproved operation",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          checkerAttestations: bundleWithDisallowedOperation(
            fixture.checker.bundle,
            fixture.checker.privateKey,
          ),
        }),
      },
      {
        name: "same maker and checker signing key",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          checkerAttestations: signedBundle(
            CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
            fixture.document.checkerSubjectRef,
            fixture.document,
            fixture.maker.privateKey,
            "same-key-checker",
          ),
          checkerPublicKey: fixture.maker.publicKey,
        }),
      },
      {
        name: "mismatched Direct endpoint",
        run: () => prepareCoreSingleSiteBootstrapExecution({
          ...preflightInput(fixture),
          environment: { PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: "https://other.internal/v1" },
        }),
      },
    ];

    for (const item of cases) {
      await expect(item.run(), item.name).rejects.toThrow(/CORE_SINGLE_SITE_BOOTSTRAP|SITE_RELEASE/u);
    }
  });
});

describe("core single-Site bootstrap CLI outputs", () => {
  it("publishes completed recovery without loading fresh authority", async () => {
    const recovered = Object.freeze({ result: safeResult(), redemptionCode:
      "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD" });
    let freshAuthorityLoads = 0;

    await expect(resolveCoreSingleSiteBootstrapCompletion({
      recoverCompleted: async () => recovered,
      executeWithFreshAuthority: async () => {
        freshAuthorityLoads += 1;
        throw new Error("expired authority should not be loaded");
      },
    })).resolves.toBe(recovered);
    expect(freshAuthorityLoads).toBe(0);
  });

  it("requires fresh authority when completed recovery is absent", async () => {
    await expect(resolveCoreSingleSiteBootstrapCompletion({
      recoverCompleted: async () => null,
      executeWithFreshAuthority: async () => { throw new Error("FRESH_AUTHORITY_REQUIRED"); },
    })).rejects.toThrow("FRESH_AUTHORITY_REQUIRED");
  });

  it("parses the exact seven absolute path options", () => {
    const values = ["file", "result", "redemption-code", "maker-attestation", "maker-public-key",
      "checker-attestation", "checker-public-key"] as const;
    const args = values.flatMap((name) => [`--${name}`, `/run/${name}`]);
    expect(coreSingleSiteBootstrapArguments(args)).toEqual({
      file: "/run/file",
      result: "/run/result",
      redemptionCode: "/run/redemption-code",
      makerAttestation: "/run/maker-attestation",
      makerPublicKey: "/run/maker-public-key",
      checkerAttestation: "/run/checker-attestation",
      checkerPublicKey: "/run/checker-public-key",
    });
    expect(() => coreSingleSiteBootstrapArguments([...args, "--file", "/other"]))
      .toThrow("CORE_SINGLE_SITE_BOOTSTRAP_ARGUMENTS_INVALID");
    expect(() => coreSingleSiteBootstrapArguments(args.map((value) =>
      value === "/run/result" ? "relative" : value)))
      .toThrow("CORE_SINGLE_SITE_BOOTSTRAP_ARGUMENTS_INVALID");
  });

  it("publishes code first and a safe result completion marker atomically at 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-output-"));
    const resultPath = join(directory, "result.json");
    const redemptionCodePath = join(directory, "redemption-code");
    const result = safeResult();

    const receipt = await publishCoreSingleSiteBootstrapOutputs({
      resultPath,
      redemptionCodePath,
      result,
      redemptionCode: "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD",
      persisted: persistedCode(),
      allowCreateCode: true,
    });
    const [resultText, codeText, resultStat, codeStat] = await Promise.all([
      readFile(resultPath, "utf8"),
      readFile(redemptionCodePath, "utf8"),
      stat(resultPath),
      stat(redemptionCodePath),
    ]);

    expect(JSON.parse(resultText)).toEqual(result);
    expect(codeText).toBe("KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD\n");
    expect(resultStat.mode & 0o777).toBe(0o600);
    expect(codeStat.mode & 0o777).toBe(0o600);
    expect(receipt.resultDigest).toBe(createHash("sha256").update(resultText).digest("hex"));
    await expect(publishCoreSingleSiteBootstrapOutputs({
      resultPath, redemptionCodePath, result,
      redemptionCode: codeText.trim(),
      persisted: persistedCode(),
      allowCreateCode: true,
    })).resolves.toEqual(receipt);

    await writeFile(redemptionCodePath, "different\n", { mode: 0o600 });
    await expect(publishCoreSingleSiteBootstrapOutputs({
      resultPath, redemptionCodePath, result,
      redemptionCode: codeText.trim(),
      persisted: persistedCode(),
      allowCreateCode: true,
    })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
  });

  it("does not create a redemption code when the result side already conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-output-conflict-"));
    const resultPath = join(directory, "result.json");
    const redemptionCodePath = join(directory, "redemption-code");
    await writeFile(resultPath, "conflicting result\n", { mode: 0o600 });

    await expect(publishCoreSingleSiteBootstrapOutputs({
      resultPath,
      redemptionCodePath,
      result: safeResult(),
      redemptionCode: "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD",
      persisted: persistedCode(),
      allowCreateCode: true,
    })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
    await expect(access(redemptionCodePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${resultPath}.pair`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes exactly one complete output pair under a conflicting concurrent race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-output-race-"));
    const resultPath = join(directory, "result.json");
    const redemptionCodePath = join(directory, "redemption-code");
    const candidates = [
      {
        result: { ...safeResult(), configDigest: sha("a") },
        redemptionCode: "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD",
      },
      {
        result: { ...safeResult(), configDigest: sha("b") },
        redemptionCode: "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-EEEEEEEE",
      },
    ] as const;

    const outcomes = await Promise.allSettled(candidates.map((candidate) =>
      publishCoreSingleSiteBootstrapOutputs({
        resultPath,
        redemptionCodePath,
        ...candidate,
        persisted: persistedCode(),
        allowCreateCode: true,
      })));
    const winner = outcomes.findIndex(({ status }) => status === "fulfilled");
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(winner).toBeGreaterThanOrEqual(0);
    const selected = candidates[winner]!;
    const [pair, code, result] = await Promise.all([
      readFile(`${resultPath}.pair`, "utf8").then((value) => JSON.parse(value)),
      readFile(redemptionCodePath, "utf8"),
      readFile(resultPath, "utf8").then((value) => JSON.parse(value)),
    ]);
    expect(result).toEqual(selected.result);
    expect(code).toBe(`${selected.redemptionCode}\n`);
    expect(pair).toMatchObject({
      configDigest: selected.result.configDigest,
      resultDigest: createHash("sha256")
        .update(`${JSON.stringify(selected.result)}\n`)
        .digest("hex"),
      redemptionCodeDigest: createHash("sha256")
        .update(`${selected.redemptionCode}\n`)
        .digest("hex"),
    });
  });

  it("verifies terminal code output in place and never recreates a missing pair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-terminal-output-"));
    const resultPath = join(directory, "result.json");
    const redemptionCodePath = join(directory, "redemption-code");
    const redemptionCode =
      "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD";
    const result = safeResult();
    await publishCoreSingleSiteBootstrapOutputs({
      resultPath,
      redemptionCodePath,
      result,
      redemptionCode,
      persisted: persistedCode(),
      allowCreateCode: true,
    });
    const before = await Promise.all([
      readFile(`${resultPath}.pair`, "utf8"),
      readFile(redemptionCodePath, "utf8"),
      readFile(resultPath, "utf8"),
    ]);

    await expect(publishCoreSingleSiteBootstrapOutputs({
      resultPath,
      redemptionCodePath,
      result,
      redemptionCode,
      persisted: persistedCode("claimed"),
      allowCreateCode: false,
    })).resolves.toMatchObject({ resultPath });
    expect(await Promise.all([
      readFile(`${resultPath}.pair`, "utf8"),
      readFile(redemptionCodePath, "utf8"),
      readFile(resultPath, "utf8"),
    ])).toEqual(before);

    const missingDirectory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-terminal-missing-"));
    const missingResult = join(missingDirectory, "result.json");
    const missingCode = join(missingDirectory, "redemption-code");
    await expect(publishCoreSingleSiteBootstrapOutputs({
      resultPath: missingResult,
      redemptionCodePath: missingCode,
      result,
      redemptionCode,
      persisted: persistedCode("claimed"),
      allowCreateCode: false,
    })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_CODE_EXPORT_UNRECOVERABLE");
    await expect(access(missingResult)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(missingCode)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(`${resultPath}.pair`, "conflicting pair\n", { mode: 0o600 });
    await expect(publishCoreSingleSiteBootstrapOutputs({
      resultPath,
      redemptionCodePath,
      result,
      redemptionCode,
      persisted: persistedCode("void"),
      allowCreateCode: false,
    })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_CODE_EXPORT_UNRECOVERABLE");
  });
});

describe("core single-Site bootstrap production bindings", () => {
  it("binds the configured Site namespace to one exact fixed HTTP metadata endpoint", async () => {
    const fixture = signedFixture();
    const directory = await mkdtemp(join(tmpdir(), "kokoro-core-site-provider-"));
    const registry = join(directory, "site-providers.json");
    const writeRegistry = (provider: Readonly<Record<string, unknown>>) => writeFile(
      registry,
      JSON.stringify({ version: 1, providers: [provider] }),
      { mode: 0o600 },
    );
    const exact = Object.freeze({
      kind: "fixed_http",
      namespace: fixture.document.site.providerNamespace,
      metadataEndpoint: fixture.document.site.metadataEndpoint,
      timeoutMs: 5_000,
    });
    await writeRegistry(exact);
    await expect(assertCoreSingleSiteBootstrapSiteProviderConfiguration(
      fixture.document,
      { PLATFORM_SITE_PROVIDER_REGISTRY_FILE: registry },
    )).resolves.toBeUndefined();

    for (const [axis, provider] of [
      ["kind", { namespace: exact.namespace, endpoint: "https://rpc.internal",
        tokenFile: "/run/secrets/site-token", timeoutMs: exact.timeoutMs }],
      ["namespace", { ...exact, namespace: "other.fixed" }],
      ["endpoint", { ...exact,
        metadataEndpoint: "https://other-site.internal/api/release/metadata" }],
    ] as const) {
      await writeRegistry(provider);
      await expect(assertCoreSingleSiteBootstrapSiteProviderConfiguration(
        fixture.document,
        { PLATFORM_SITE_PROVIDER_REGISTRY_FILE: registry },
      ), axis).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_SITE_PROVIDER_MISMATCH");
    }
  });

  it("fails the bootstrap cycle when any verification event reaches its queue", async () => {
    const auditDigest = createIdentityAuditDigester(new Uint8Array(32).fill(7));
    const payload = {
      kind: "sealed_identity_verification_v1",
      credentialRevision: 0,
      sealedEnvelope: {
        algorithm: "A256GCM", keyRevision: "core-test-key",
        nonce: Buffer.alloc(12, 1).toString("base64url"),
        ciphertext: Buffer.from("unexpected-bootstrap-verification").toString("base64url"),
        authenticationTag: Buffer.alloc(16, 2).toString("base64url"),
      },
    } as const;
    const event: ClaimedOutboxEvent = {
      eventId: "unexpected-verification-event", owner: "identity",
      eventType: "identity.verification.delivery.requested", aggregateId: "verification:core",
      payload, payloadDigest: auditDigest(payload), correlationId: "correlation:core",
      causationId: "command:core", leaseToken: "lease:core", attempt: 1,
    };
    let persistedFailure = false;
    const queue: IdentityEffectEventQueue = {
      claim: async () => [event],
      renew: async () => undefined,
      prepareVerification: async () => "dispatch",
      completeVerification: async () => undefined,
      applyNamespace: async () => undefined,
      fail: async () => { persistedFailure = true; },
      releaseOwned: async () => undefined,
    };
    const consumer = createCoreSingleSiteBootstrapIdentityOutboxConsumer(queue, auditDigest,
      () => NOW);

    const failure = await consumer.runOneCycle({ signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toMatchObject([
      { message: "CORE_BOOTSTRAP_UNEXPECTED_VERIFICATION_DELIVERY" },
    ]);
    expect(persistedFailure).toBe(false);
  });

  it("fails immediately if the bootstrap identity cycle observes verification delivery", async () => {
    await expect(CORE_SINGLE_SITE_BOOTSTRAP_IDENTITY_DELIVERY.publish(
      {} as never,
      new AbortController().signal,
    )).rejects.toThrow("CORE_BOOTSTRAP_UNEXPECTED_VERIFICATION_DELIVERY");
  });

  it("ships the compiled bootstrap runtime selector and package entry", async () => {
    const [selector, packageText] = await Promise.all([
      readFile(join(process.cwd(), "deploy/docker/runtime-entrypoint.mjs"), "utf8"),
      readFile(join(process.cwd(), "package.json"), "utf8"),
    ]);
    expect(selector).toContain('"platform-core-single-site-bootstrap"');
    expect(selector).toContain('start: "runCoreSingleSiteBootstrapMain"');
    expect(JSON.parse(packageText)).toMatchObject({ scripts: {
      "start:core-single-site-bootstrap":
        "node --conditions=kokoro-runtime dist/src/process/core-single-site-bootstrap.js",
    } });
  });

  it("binds four independent credential URLs to their exact runtime classes", () => {
    const shared = { PLATFORM_DATABASE_EXPECTED_DATABASE: "kokoro" };
    const environments = coreSingleSiteBootstrapDatabaseEnvironments({
      ...shared,
      DATABASE_URL_PLATFORM_ADMIN: "postgresql://admin@example.test/kokoro",
      DATABASE_URL_PLATFORM_API: "postgresql://api@example.test/kokoro",
      DATABASE_URL_PLATFORM_SITE_WORKER: "postgresql://site_worker@example.test/kokoro",
      DATABASE_URL_PLATFORM_IDENTITY_WORKER: "postgresql://identity_worker@example.test/kokoro",
    });
    expect(environments.admin).toMatchObject({
      DATABASE_URL_PLATFORM: "postgresql://admin@example.test/kokoro",
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
    });
    expect(environments.api.PLATFORM_DATABASE_CREDENTIAL_CLASS).toBe("api");
    expect(environments.siteWorker.PLATFORM_DATABASE_CREDENTIAL_CLASS).toBe("site-worker");
    expect(environments.identityWorker.PLATFORM_DATABASE_CREDENTIAL_CLASS).toBe("identity-worker");
    expect(() => coreSingleSiteBootstrapDatabaseEnvironments({
      DATABASE_URL_PLATFORM_ADMIN: "postgresql://same@example.test/kokoro",
      DATABASE_URL_PLATFORM_API: "postgresql://same@example.test/kokoro",
      DATABASE_URL_PLATFORM_SITE_WORKER: "postgresql://site@example.test/kokoro",
      DATABASE_URL_PLATFORM_IDENTITY_WORKER: "postgresql://identity@example.test/kokoro",
    })).toThrow("CORE_SINGLE_SITE_BOOTSTRAP_DATABASE_URLS_NOT_DISTINCT");
  });

  it("freezes the empty Hub catalog and waits for its committed Platform projection", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const requests: Array<Readonly<{ method: string; value: unknown }>> = [];
    const publication = {
      agentCatalogRef: fixture.document.externalEmptyAgentCatalogRef,
      siteId: fixture.document.site.siteId,
      siteReleaseRef: fixture.document.site.siteReleaseRef,
    };
    const port = createHubCapabilityCatalogPublicationPort({
      client: {
        freezeCatalog: async (value) => {
          requests.push({ method: "freeze", value });
          return { publication, projectionState: CatalogProjectionState.PENDING, replayed: false,
            receipt: { state: CommandReceiptState.COMMITTED,
              operation: "capability_catalog.freeze", identity: value.command } };
        },
        getCatalogPublication: async (value) => {
          requests.push({ method: "get", value });
          return { publication, projectionState: CatalogProjectionState.COMMITTED,
            receipt: { state: CommandReceiptState.COMMITTED,
              operation: "capability_catalog.freeze", identity: value } };
        },
      },
      sleep: async () => undefined,
      now: (() => {
        let current = 0;
        return () => current++;
      })(),
      timeoutMs: 10,
    });

    await expect(port.ensureEmpty(execution)).resolves
      .toBe(fixture.document.externalEmptyAgentCatalogRef);
    expect(requests.map(({ method }) => method)).toEqual(["freeze", "get"]);
    expect(requests[0]?.value).toMatchObject({ effect: {
      siteId: fixture.document.site.siteId,
      siteReleaseRef: fixture.document.site.siteReleaseRef,
      snapshot: { schemaVersion: 1, agentOptions: [], tools: [], skillOptions: [], mcpOptions: [], subagents: [] },
    } });
  });

  it("binds every production readback placeholder to the exact authority value", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const placeholders = [...CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL.matchAll(/\$(\d+)/gu)]
      .map((match) => Number(match[1]));
    expect(Math.max(...placeholders)).toBe(24);
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).toContain(
      "platform.core_single_site_bootstrap_identity_ready",
    );
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).toContain(
      "platform.core_single_site_bootstrap_model_catalog_ready",
    );
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).not.toContain("platform.outbox_event");
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).not.toContain(
      "FROM platform.site_release_model_catalog_publication catalog",
    );
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).not.toContain("model_inventory_pointer");
    const expectedOwnerFacts = coreSingleSiteBootstrapExpectedOwnerFacts(execution);
    expect(expectedOwnerFacts).not.toHaveProperty("workloadBindingEpoch");
    expect(expectedOwnerFacts).not.toHaveProperty("runtimeBindingEpoch");
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).not.toContain(
      "binding.binding_epoch=($24::jsonb->>'workloadBindingEpoch')",
    );
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).not.toContain("runtimeBindingEpoch");
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).toContain(
      "deployment.binding_epoch=site.runtime_binding_epoch",
    );
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).toContain(
      "authorization_binding.binding_epoch=deployment.binding_epoch",
    );
    const values = coreSingleSiteBootstrapReadbackValues(execution);
    expect(values.slice(0, 23)).toEqual([
      fixture.document.site.siteId,
      fixture.document.site.siteReleaseRef,
      fixture.document.site.webArtifactDigest,
      execution.recipe.inventory.digest,
      execution.recipe.modelOptionRevisionRef,
      execution.recipe.modelOptionCatalogRef,
      execution.recipe.launchProfileRef,
      fixture.document.externalEmptyAgentCatalogRef,
      fixture.document.rating.policyRevisionRef,
      fixture.document.redemption.batchRef,
      fixture.document.identity.accountRef,
      fixture.document.identity.subjectRef,
      fixture.document.identity.workspaceRef,
      fixture.document.identity.projectRef,
      fixture.document.identity.billingAccountRef,
      fixture.document.identity.executionSpaceRef,
      fixture.document.identity.executionNamespace,
      fixture.document.rating.unit,
      fixture.document.redemption.creditProgramRevisionRef,
      fixture.document.redemption.productVersionRef,
      fixture.document.redemption.programRevisionRef,
      fixture.document.environment,
      fixture.document.region,
    ]);
    expect(JSON.parse(String(values[23]))).toMatchObject({
      creditAmount: fixture.document.redemption.amount,
      creditLiabilityMerchantAccountRef:
        fixture.document.redemption.liabilityMerchantAccountRef,
      fulfillmentProgramRevisionRef:
        fixture.document.redemption.fulfillmentProgramRevisionRef,
      siteKey: fixture.document.site.siteKey,
      siteProjectBindingRef: fixture.document.site.siteProjectBindingRef,
      providerNamespace: fixture.document.site.providerNamespace,
      providerProjectRef: fixture.document.site.providerProjectRef,
      workloadIdentityId: fixture.document.site.workloadIdentityId,
      releaseManifestDigest: fixture.document.site.releaseManifestDigest,
      certificationDigest: fixture.document.site.certificationDigest,
    });
  });

  it.each([
    ["rating digest", "rating.policy_digest=($24::jsonb->>'ratingPolicyDigest')"],
    ["rating prices", "rating.policy=($24::jsonb->'ratingPolicy')"],
    ["credit amount", "credit_program.amount=($24::jsonb->>'creditAmount')::numeric"],
    ["credit liability",
      "credit_program.liability_merchant_account_ref=" +
        "($24::jsonb->>'creditLiabilityMerchantAccountRef')"],
    ["credit scope", "credit_program.scope_policy=($24::jsonb->'creditScopePolicy')"],
    ["credit revision", "credit_program.revision_digest=" +
      "($24::jsonb->>'creditProgramRevisionDigest')"],
    ["product fulfillment", "product.fulfillment_program_revision_ref=" +
      "($24::jsonb->>'fulfillmentProgramRevisionRef')"],
    ["product revision", "product.revision_digest=($24::jsonb->>'productRevisionDigest')"],
    ["fulfillment output", "output.credit_program_revision_ref=$19"],
    ["fulfillment digest", "fulfillment.output_plan_digest=" +
      "($24::jsonb->>'fulfillmentOutputPlanDigest')"],
    ["program product", "program.product_version_ref=$20"],
    ["program fulfillment", "program.fulfillment_program_revision_ref=" +
      "($24::jsonb->>'fulfillmentProgramRevisionRef')"],
    ["program digest", "program.program_digest=($24::jsonb->>'redemptionProgramDigest')"],
    ["batch program", "batch.redemption_program_revision_ref=$21"],
    ["site key", "site.site_key=($24::jsonb->>'siteKey')"],
    ["release manifest", "release.release_manifest_digest=" +
      "($24::jsonb->>'releaseManifestDigest')"],
    ["release certification", "release.certification_digest=" +
      "($24::jsonb->>'certificationDigest')"],
    ["release launch profile", "release.launch_profile_ref=$7"],
    ["release site config", "release.site_config_revision_ref=" +
      "($24::jsonb->>'siteConfigRevisionRef')"],
    ["release legal", "release.legal_revision_ref=($24::jsonb->>'legalRevisionRef')"],
    ["release feature policy", "release.feature_policy_revision=" +
      "($24::jsonb->>'featurePolicyRevision')"],
    ["release issuer", "release.identity_issuer_label=" +
      "($24::jsonb->>'identityIssuerLabel')"],
    ["release auth strength", "release.identity_auth_strength_policy_revision=" +
      "($24::jsonb->>'identityAuthStrengthPolicyRevision')"],
    ["release surfaces", "release.enabled_surface_ids=($24::jsonb->'enabledSurfaceIds')"],
    ["release locales", "release.locale_policy=($24::jsonb->'localePolicy')"],
    ["deployment project binding", "deployment.binding_ref=" +
      "($24::jsonb->>'siteProjectBindingRef')"],
    ["deployment web", "deployment.web_artifact_digest=$3"],
    ["deployment audience", "deployment.audience=($24::jsonb->>'audience')"],
    ["deployment session", "deployment.session_contract_revision=" +
      "($24::jsonb->>'sessionContractRevision')"],
    ["deployment epoch", "deployment.binding_epoch=site.runtime_binding_epoch"],
    ["binding ref", "binding.binding_ref=($24::jsonb->>'siteProjectBindingRef')"],
    ["binding site", "binding.site_ref=site.site_ref"],
    ["binding repository", "binding.repository_ref=($24::jsonb->>'siteRepositoryRef')"],
    ["binding provider namespace", "binding.provider_namespace=" +
      "($24::jsonb->>'providerNamespace')"],
    ["binding provider project", "binding.provider_project_ref=" +
      "($24::jsonb->>'providerProjectRef')"],
    ["binding workload identity", "binding.workload_identity_id=" +
      "($24::jsonb->>'workloadIdentityId')"],
    ["binding environment", "binding.environment=$22"],
    ["binding region", "binding.region=$23"],
    ["binding state", "binding.state='active'"],
    ["authorization Site", "authorization_site.site_ref=site.site_ref"],
    ["authorization Site state", "authorization_site.state='active'"],
    ["authorization Site security", "authorization_site.security_epoch=site.security_epoch"],
    ["authorization Site policy", "authorization_site.policy_epoch=site.policy_epoch"],
    ["authorization Site revocation", "authorization_site.revocation_epoch=site.revocation_epoch"],
    ["authorization release ref", "authorization_release.release_ref=release.release_ref"],
    ["authorization release site", "authorization_release.site_ref=site.site_ref"],
    ["authorization release state", "authorization_release.state='active'"],
    ["authorization release web", "authorization_release.web_artifact_digest=" +
      "release.web_artifact_digest"],
    ["authorization release surfaces", "authorization_release.enabled_surface_ids=" +
      "release.enabled_surface_ids"],
    ["authorization release feature", "authorization_release.feature_policy_revision=" +
      "release.feature_policy_revision"],
    ["authorization release model", "authorization_release.model_option_catalog_ref=" +
      "release.model_option_catalog_ref"],
    ["authorization release agent", "authorization_release.agent_catalog_ref=" +
      "release.agent_catalog_ref"],
    ["authorization release issuer", "authorization_release.identity_issuer_label=" +
      "release.identity_issuer_label"],
    ["authorization release auth", "authorization_release.identity_auth_strength_policy_revision=" +
      "release.identity_auth_strength_policy_revision"],
    ["authorization release locale", "authorization_release.locale_policy=release.locale_policy"],
    ["authorization binding ref", "authorization_binding.binding_ref=binding.binding_ref"],
    ["authorization binding workload", "authorization_binding.workload_identity_id=" +
      "binding.workload_identity_id"],
    ["authorization binding deployment", "authorization_binding.deployment_ref=" +
      "deployment.deployment_ref"],
    ["authorization binding Site", "authorization_binding.site_ref=site.site_ref"],
    ["authorization binding release", "authorization_binding.release_ref=release.release_ref"],
    ["authorization binding environment", "authorization_binding.environment=deployment.environment"],
    ["authorization binding region", "authorization_binding.region=deployment.region"],
    ["authorization binding audience", "authorization_binding.audience=deployment.audience"],
    ["authorization binding session", "authorization_binding.session_contract_revision=" +
      "deployment.session_contract_revision"],
    ["authorization binding epoch", "authorization_binding.binding_epoch=" +
      "deployment.binding_epoch"],
    ["authorization binding state", "authorization_binding.state='active'"],
  ] as const)("locks the persisted %s axis in production readback", (_axis, fragment) => {
    expect(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL).toContain(fragment);
  });

  it.each([
    ["ratingPolicyDigest", (document: CoreSingleSiteBootstrapDocument) => ({
      ...document,
      rating: { ...document.rating, inputTokenAmount: "2" },
    })],
    ["creditProgramRevisionDigest", (document: CoreSingleSiteBootstrapDocument) => ({
      ...document,
      redemption: { ...document.redemption, amount: "250001" },
    })],
    ["productRevisionDigest", (document: CoreSingleSiteBootstrapDocument) => ({
      ...document,
      redemption: {
        ...document.redemption,
        fulfillmentProgramRevisionRef: "fulfillment:core-credit:2",
      },
    })],
    ["redemptionProgramDigest", (document: CoreSingleSiteBootstrapDocument) => ({
      ...document,
      redemption: { ...document.redemption, productVersionRef: "product:core-credit:2" },
    })],
  ] as const)("changes canonical owner fact %s when its source axis changes", (field, mutate) => {
    const fixture = signedFixture();
    const original = {
      document: fixture.document,
      recipe: createCoreSingleSiteBootstrapRecipe(fixture.document),
    };
    const document = mutate(fixture.document) as CoreSingleSiteBootstrapDocument;
    const changed = { document, recipe: createCoreSingleSiteBootstrapRecipe(document) };

    expect(coreSingleSiteBootstrapExpectedOwnerFacts(changed)[field]).not.toBe(
      coreSingleSiteBootstrapExpectedOwnerFacts(original)[field],
    );
  });

  it("recovers a completed production receipt through the exact strict SQL readback", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const fake = recordingOwners(execution);
    const completed = await executeCoreSingleSiteBootstrap(execution, fake.owners);
    const queries: Array<Readonly<{ statement: string; values: readonly unknown[] }>> = [];
    let observedFence: CoreBootstrapRecoveryFence | undefined;
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(
        statement: string,
        values: readonly unknown[] = [],
      ): Promise<readonly Row[]> => {
        queries.push({ statement, values });
        const rows = statement.includes("FROM platform.command_receipt")
          ? [{
              commandId: coreBootstrapUuid(fixture.document.bootstrapId, "configuration.guard"),
              environment: fixture.document.environment,
              region: fixture.document.region,
              callerIdentity: `core-single-site-bootstrap:${fixture.document.makerSubjectRef}`,
              operation: "core.single-site.bootstrap",
              idempotencyKey: `core-bootstrap:${fixture.document.bootstrapId}:configuration.guard`,
              requestDigest: execution.configDigest,
              state: "succeeded",
              result: completed.result,
              resultDigest: coreSingleSiteBootstrapResultDigest(completed.result),
            }]
          : [{
              deploymentRef: completed.result.site.deploymentRef,
              safeCodeFingerprint: completed.result.redemption.safeCodeFingerprint,
              codeKeyRevision: "code-key-v1",
              codeBatchSelector: "AAAAAAAAAA",
              codeLookupDigest: sha("9"),
              codeState: "available",
              codeCount: 1,
              modelReady: true,
              launchReady: true,
              capabilityReady: true,
              identityReady: true,
              ratingReady: true,
              commerceReady: true,
            }];
        return rows as unknown as readonly Row[];
      },
      execute: async () => 0,
    };
    const recovery = createCoreSingleSiteBootstrapProductionRecovery({
      coreBootstrapRecoveryTransaction: async <Result>(
        fence: CoreBootstrapRecoveryFence,
        work: (transaction: PlatformTransaction) => Promise<Result>,
      ) => {
        observedFence = fence;
        const lease = issuePlatformTransaction(sql);
        try { return await work(lease.transaction); }
        finally { revokePlatformTransaction(lease); }
      },
    });

    await expect(recovery.recover({
      document: fixture.document,
      recipe: execution.recipe,
      configDigest: execution.configDigest,
    })).resolves.toEqual({ result: completed.result, persisted: completed.persisted });
    expect(observedFence).toEqual({
      bootstrapId: fixture.document.bootstrapId,
      siteRef: fixture.document.site.siteId,
      makerSubjectRef: fixture.document.makerSubjectRef,
      environment: fixture.document.environment,
      region: fixture.document.region,
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]?.statement).toBe(CORE_SINGLE_SITE_BOOTSTRAP_READBACK_SQL);
    expect(queries[1]?.values).toEqual(coreSingleSiteBootstrapReadbackValues(execution));
  });

  it.each(["region", "resultDigest"] as const)(
    "rejects a completed receipt whose %s is not exact",
    async (mutation) => {
      const fixture = signedFixture();
      const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
      const completed = await executeCoreSingleSiteBootstrap(execution, recordingOwners(execution).owners);
      let queries = 0;
      const sql: PlatformSqlTransaction = {
        query: async <Row extends Record<string, unknown>>(statement: string) => {
          queries += 1;
          if (statement.includes("FROM platform.command_receipt")) {
            return [{
              commandId: coreBootstrapUuid(fixture.document.bootstrapId, "configuration.guard"),
              environment: fixture.document.environment,
              region: mutation === "region" ? "eu-west-1" : fixture.document.region,
              callerIdentity: `core-single-site-bootstrap:${fixture.document.makerSubjectRef}`,
              operation: "core.single-site.bootstrap",
              idempotencyKey: `core-bootstrap:${fixture.document.bootstrapId}:configuration.guard`,
              requestDigest: execution.configDigest,
              state: "succeeded",
              result: completed.result,
              resultDigest: mutation === "resultDigest"
                ? sha("0")
                : coreSingleSiteBootstrapResultDigest(completed.result),
            }] as unknown as readonly Row[];
          }
          return [{
            deploymentRef: completed.result.site.deploymentRef,
            safeCodeFingerprint: completed.result.redemption.safeCodeFingerprint,
            codeKeyRevision: completed.persisted.keyRevision,
            codeBatchSelector: completed.persisted.batchSelector,
            codeLookupDigest: completed.persisted.lookupDigest,
            codeState: "available",
            codeCount: 1,
            modelReady: true,
            launchReady: true,
            capabilityReady: true,
            identityReady: true,
            ratingReady: true,
            commerceReady: true,
          }] as unknown as readonly Row[];
        },
        execute: async () => 0,
      };
      const recovery = createCoreSingleSiteBootstrapProductionRecovery({
        coreBootstrapRecoveryTransaction: async <Result>(
          _fence: CoreBootstrapRecoveryFence,
          work: (transaction: PlatformTransaction) => Promise<Result>,
        ) => {
          const lease = issuePlatformTransaction(sql);
          try { return await work(lease.transaction); }
          finally { revokePlatformTransaction(lease); }
        },
      });

      await expect(recovery.recover({
        document: fixture.document,
        recipe: execution.recipe,
        configDigest: execution.configDigest,
      })).rejects.toThrow(mutation === "region"
        ? "CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT"
        : "CORE_SINGLE_SITE_BOOTSTRAP_COMPLETION_RECEIPT_INVALID");
      expect(queries).toBe(mutation === "region" ? 1 : 2);
    },
  );

  it("recovers a terminal production code identity without treating it as a fresh issue", async () => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const completed = await executeCoreSingleSiteBootstrap(execution, recordingOwners(execution).owners);
    const terminal = { ...completed.persisted, state: "claimed" as const };
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string) => {
        const rows = statement.includes("FROM platform.command_receipt")
          ? [{
              commandId: coreBootstrapUuid(fixture.document.bootstrapId, "configuration.guard"),
              environment: fixture.document.environment,
              region: fixture.document.region,
              callerIdentity: `core-single-site-bootstrap:${fixture.document.makerSubjectRef}`,
              operation: "core.single-site.bootstrap",
              idempotencyKey: `core-bootstrap:${fixture.document.bootstrapId}:configuration.guard`,
              requestDigest: execution.configDigest,
              state: "succeeded",
              result: completed.result,
              resultDigest: coreSingleSiteBootstrapResultDigest(completed.result),
            }]
          : [{
              deploymentRef: completed.result.site.deploymentRef,
              safeCodeFingerprint: terminal.safeFingerprint,
              codeKeyRevision: terminal.keyRevision,
              codeBatchSelector: terminal.batchSelector,
              codeLookupDigest: terminal.lookupDigest,
              codeState: terminal.state,
              codeCount: 1,
              modelReady: true,
              launchReady: true,
              capabilityReady: true,
              identityReady: true,
              ratingReady: true,
              commerceReady: true,
            }];
        return rows as unknown as readonly Row[];
      },
      execute: async () => 0,
    };
    const recovery = createCoreSingleSiteBootstrapProductionRecovery({
      coreBootstrapRecoveryTransaction: async <Result>(
        _fence: CoreBootstrapRecoveryFence,
        work: (transaction: PlatformTransaction) => Promise<Result>,
      ) => {
        const lease = issuePlatformTransaction(sql);
        try { return await work(lease.transaction); }
        finally { revokePlatformTransaction(lease); }
      },
    });

    await expect(recovery.recover({
      document: fixture.document,
      recipe: execution.recipe,
      configDigest: execution.configDigest,
    })).resolves.toEqual({ result: completed.result, persisted: terminal });
  });

  it.each([
    ["succeeded", "maker"],
    ["pending", "maker"],
    ["succeeded", "environment"],
    ["pending", "environment"],
  ] as const)("closes %s bootstrap identity before %s drift can reach readback", async (
    state,
    drift,
  ) => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const mutated = drift === "maker"
      ? { ...fixture.document, makerSubjectRef: "operator:other-maker" }
      : { ...fixture.document, environment: "staging" as const };
    let queries = 0;
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>() => {
        queries += 1;
        return [{
          commandId: coreBootstrapUuid(fixture.document.bootstrapId, "configuration.guard"),
          environment: fixture.document.environment,
          region: fixture.document.region,
          callerIdentity: `core-single-site-bootstrap:${fixture.document.makerSubjectRef}`,
          operation: "core.single-site.bootstrap",
          idempotencyKey: `core-bootstrap:${fixture.document.bootstrapId}:configuration.guard`,
          requestDigest: execution.configDigest,
          state,
          result: null,
          resultDigest: null,
        }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    };
    const recovery = createCoreSingleSiteBootstrapProductionRecovery({
      coreBootstrapRecoveryTransaction: async <Result>(_fence: CoreBootstrapRecoveryFence,
        work: (transaction: PlatformTransaction) => Promise<Result>) => {
        const lease = issuePlatformTransaction(sql);
        try { return await work(lease.transaction); }
        finally { revokePlatformTransaction(lease); }
      },
    });

    await expect(recovery.recover({
      document: mutated,
      recipe: createCoreSingleSiteBootstrapRecipe(mutated),
      configDigest: coreBootstrapConfigDigest(mutated, execution.secretDigests),
    })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
    expect(queries).toBe(1);
  });

  it.each([
    ["freeze", "commandId"],
    ["freeze", "idempotencyKey"],
    ["freeze", "digestAlgorithm"],
    ["freeze", "requestDigest"],
    ["freeze", "operation"],
    ["freeze", "state"],
    ["poll", "commandId"],
    ["poll", "idempotencyKey"],
    ["poll", "digestAlgorithm"],
    ["poll", "requestDigest"],
    ["poll", "operation"],
    ["poll", "state"],
  ] as const)("rejects a %s Hub receipt with a mismatched %s", async (phase, field) => {
    const fixture = signedFixture();
    const execution = await prepared(fixture, { password: sha("1"), redemptionEntropy: sha("2") });
    const publication = {
      agentCatalogRef: fixture.document.externalEmptyAgentCatalogRef,
      siteId: fixture.document.site.siteId,
      siteReleaseRef: fixture.document.site.siteReleaseRef,
    };
    const receipt = (identity: Readonly<{
      commandId: string;
      idempotencyKey: string;
      digestAlgorithm: CommandDigestAlgorithm;
      requestDigest: string;
    }>, mutate: boolean) => ({
      state: mutate && field === "state"
        ? CommandReceiptState.ACCEPTED
        : CommandReceiptState.COMMITTED,
      operation: mutate && field === "operation"
        ? "capability_catalog.other"
        : "capability_catalog.freeze",
      identity: {
        ...identity,
        ...(mutate && field === "commandId" ? { commandId: uuid("wrong") } : {}),
        ...(mutate && field === "idempotencyKey" ? { idempotencyKey: "wrong" } : {}),
        ...(mutate && field === "digestAlgorithm"
          ? { digestAlgorithm: CommandDigestAlgorithm.UNSPECIFIED }
          : {}),
        ...(mutate && field === "requestDigest" ? { requestDigest: sha("f") } : {}),
      },
    });
    const port = createHubCapabilityCatalogPublicationPort({
      client: {
        freezeCatalog: async (value) => ({
          publication,
          projectionState: phase === "freeze"
            ? CatalogProjectionState.COMMITTED
            : CatalogProjectionState.PENDING,
          receipt: receipt(value.command, phase === "freeze"),
        }),
        getCatalogPublication: async (value) => ({
          publication,
          projectionState: CatalogProjectionState.COMMITTED,
          receipt: receipt(value, true),
        }),
      },
      sleep: async () => undefined,
      now: (() => { let current = 0; return () => current++; })(),
      timeoutMs: 10,
    });

    await expect(port.ensureEmpty(execution)).rejects
      .toThrow("CORE_SINGLE_SITE_BOOTSTRAP_CAPABILITY_PUBLICATION_INVALID");
  });
});

function signedFixture() {
  const makerKeys = generateKeyPairSync("ed25519");
  const checkerKeys = generateKeyPairSync("ed25519");
  const certificationKeys = generateKeyPairSync("ed25519");
  const raw = baseDocument();
  const model = fixtureModel(raw);
  raw.model.optionRevisionRef = model.optionRevisionRef;
  raw.model.catalogRef = model.catalogRef;
  const initial = createCoreSingleSiteBootstrapRecipe(raw as CoreSingleSiteBootstrapDocument);
  const proof = raw.site.releaseCertification;
  const payload = canonicalCertificationPayload({
    ...initial.siteRelease,
    proof: {
      signingKeyRef: proof.signingKeyRef,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
    },
  });
  raw.site.certificationDigest = createHash("sha256").update(payload).digest("hex");
  raw.site.releaseCertification.signature = sign(
    null,
    Buffer.concat([
      Buffer.from("kokoro.site-release-certification.v1\0", "utf8"),
      Buffer.from(payload, "utf8"),
    ]),
    certificationKeys.privateKey,
  ).toString("base64url");
  const document = raw as CoreSingleSiteBootstrapDocument;
  return {
    document,
    maker: {
      ...makerKeys,
      bundle: signedBundle(CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
        document.makerSubjectRef, document, makerKeys.privateKey, "maker"),
    },
    checker: {
      ...checkerKeys,
      bundle: signedBundle(CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
        document.checkerSubjectRef, document, checkerKeys.privateKey, "checker"),
    },
    certification: {
      ...certificationKeys,
      authority: new Ed25519SiteReleaseCertificationAuthority([{
        signingKeyRef: proof.signingKeyRef,
        publicKey: certificationKeys.publicKey,
      }]),
    },
  };
}

function baseDocument() {
  return {
    version: 1 as const,
    bootstrapId: uuid("1"),
    environment: "production" as const,
    region: "us-east-1",
    makerSubjectRef: "operator:core-maker",
    checkerSubjectRef: "operator:core-checker",
    site: {
      siteId: "site:core",
      siteKey: "core-site",
      siteReleaseRef: "site-release:core:1",
      siteProjectBindingRef: "site-binding:core:1",
      workloadIdentityId: "spiffe://kokoro/site/core",
      workloadBindingEpoch: "1",
      providerNamespace: "core.fixed",
      providerProjectRef: "core-site",
      metadataEndpoint: "http://kokoro-site-release.internal:3000/api/release/metadata",
      webArtifactDigest: sha("a"),
      releaseManifestDigest: sha("b"),
      certificationDigest: sha("c"),
      releaseCertification: {
        signingKeyRef: "site-release-key:core",
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        signature: "A".repeat(86),
      },
      audience: "site-product",
      sessionContractRevision: "session-browser-v3",
    },
    model: {
      provider: "direct" as const,
      providerKey: "direct",
      modelKey: "chat-primary",
      modelOptionKey: "chat.standard",
      endpoint: "https://direct-model.internal/v1",
      inventoryRef: "model-inventory:core",
      optionRevisionRef: "model-option:placeholder",
      catalogRef: "model-catalog:placeholder",
    },
    rating: {
      policyRevisionRef: "rating-policy:core:1",
      unit: "credit",
      inputTokenAmount: "1",
      outputTokenAmount: "1",
    },
    redemption: {
      creditProgramRevisionRef: "credit-program:core:1",
      productVersionRef: "product:core-credit:1",
      fulfillmentProgramRevisionRef: "fulfillment:core-credit:1",
      programRevisionRef: "redemption-program:core:1",
      batchRef: uuid("2"),
      amount: "250000",
      liabilityMerchantAccountRef: "merchant:core",
      entropyKeyFile: "/run/secrets/kokoro/core-redemption-entropy",
    },
    identity: {
      email: "owner@example.test",
      passwordFile: "/run/secrets/kokoro/core-owner-password",
      accountRef: uuid("3"),
      subjectRef: "subject:core-owner",
      workspaceRef: "workspace:core-owner",
      projectRef: "project:core-owner",
      billingAccountRef: "billing:core-owner",
      executionSpaceRef: "execution-space:core-owner",
      executionNamespace: "namespace_core_owner_00000000000000",
    },
    externalEmptyAgentCatalogRef: EMPTY_AGENT_CATALOG_REF,
  };
}

function fixtureModel(document: ReturnType<typeof baseDocument>) {
  const inventory = canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: document.model.inventoryRef },
    providers: [{
      key: "direct", provider: "openai-compatible", accountKey: "primary",
      secretRef: "secret://platform/model-gateway/direct", adapterKind: "direct", priority: 0,
    }],
    models: [{
      key: document.model.modelKey, displayName: "Chat", inputModalities: ["text"],
      outputModalities: ["text"], capabilities: ["chat"], contextWindow: null, enabled: true,
    }],
    bindings: [{
      key: `binding:${document.model.modelKey}`, modelKey: document.model.modelKey,
      providerKey: "direct", upstreamModel: document.model.modelKey,
      gatewayModelName: document.model.modelKey, priority: 0, enabled: true,
    }],
    productRoutes: [{
      product: "chat", role: "main", modelKey: document.model.modelKey, position: 0,
      requiredCapabilities: ["chat"],
    }],
  });
  const selection = { primaryModelKey: document.model.modelKey, fallbackModelKeys: [] } as const;
  const option = {
    schemaVersion: 1 as const,
    optionKey: document.model.modelOptionKey,
    surface: "chat" as const,
    label: "Chat",
    description: null,
    tier: null,
    lifecycle: "active" as const,
    composition: { orchestration: selection, generation: selection },
  };
  const materialized = materializeModelOptionDraftSet({
    inventory,
    draftSet: { schemaVersion: 1, inventoryDigest: inventory.digest, options: [option] },
  });
  const optionRevisionRef = materialized.optionRevisions[0]!.modelOptionRevisionRef;
  const catalog = createSiteReleaseModelCatalogRevision({
    siteId: document.site.siteId,
    siteReleaseRef: document.site.siteReleaseRef,
    inventoryDigest: inventory.digest,
    publishedAt: NOW,
    surfaces: [{
      surfaceId: "chat",
      allowedModelOptionRevisionRefs: [optionRevisionRef],
      defaultModelOptionRevisionRef: optionRevisionRef,
    }],
    optionRevisions: materialized.optionRevisions,
  });
  return { optionRevisionRef, catalogRef: catalog.modelOptionCatalogRef };
}

function signedBundle(
  operations: readonly string[],
  operatorRef: string,
  document: CoreSingleSiteBootstrapDocument,
  privateKey: KeyObject,
  nonce: string,
  overrides: Readonly<{ region?: string }> = {},
): CoreBootstrapAdminAttestationBundle {
  return Object.freeze({
    version: 1 as const,
    attestations: Object.freeze(operations.map((operation, index) => {
      const context = adminContext(operation, operatorRef, document, `${nonce}-${index}`, overrides);
      return Object.freeze({
        operation,
        envelope: Object.freeze({
          context,
          signature: sign(null, coreBootstrapAdminAttestationPayload(context), privateKey)
            .toString("base64"),
          keyVersion: "bootstrap-1",
        }),
      });
    })),
  });
}

function adminContext(
  operation: string,
  operatorRef: string,
  document: CoreSingleSiteBootstrapDocument,
  nonce: string,
  overrides: Readonly<{ region?: string }> = {},
): RequestSecurityContext {
  const globalModel = ["model.inventory.import", "model.inventory.activate", "model.option.materialize"]
    .includes(operation);
  const siteCatalog = operation === "model.site-release-catalog.publish";
  const siteActivationChecker = operation === "site.activation.begin";
  const siteId = globalModel ? null : document.site.siteId;
  const purpose = globalModel ? "model_control_administration" : siteCatalog ? "site_release" : operation;
  const scopes = siteCatalog ? ["model:site-release:publish"] : [operation];
  const region = overrides.region ?? document.region;
  return {
    requestId: `request:${nonce}:${operation}`,
    correlationId: `correlation:${nonce}:${operation}`,
    trustedCaller: {
      workloadIdentityId: `spiffe://kokoro/admin/${operatorRef.replaceAll(":", "-")}`,
      kind: "admin_workload",
      audience: ADMIN_AUDIENCE,
      environment: document.environment,
      region,
      allowedOperations: siteActivationChecker
        ? ["site.approval.approve", "site.activation.begin"] : [operation],
      bindingEpoch: "1",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    },
    actor: { kind: "operator", subjectId: operatorRef, subjectGeneration: "1" },
    delegatedGrant: null,
    target: { siteId, workspaceId: null, projectId: null, purpose, scopes },
    audience: ADMIN_AUDIENCE,
    environment: document.environment,
    region,
    evidence: [{ kind: "signature", evidenceId: `evidence:${nonce}:${operation}`, issuer: "core-bootstrap" }],
    policyEpoch: "1",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function bundleWithDisallowedOperation(
  bundle: CoreBootstrapAdminAttestationBundle,
  privateKey: KeyObject,
): CoreBootstrapAdminAttestationBundle {
  const attestations = bundle.attestations.map((item, index) => {
    if (index !== 0) return item;
    const context = {
      ...item.envelope.context,
      trustedCaller: { ...item.envelope.context.trustedCaller, allowedOperations: ["wrong.operation"] },
    };
    return {
      ...item,
      envelope: {
        ...item.envelope,
        context,
        signature: sign(null, coreBootstrapAdminAttestationPayload(context), privateKey).toString("base64"),
      },
    };
  });
  return Object.freeze({ version: 1, attestations: Object.freeze(attestations) });
}

function refreshAttestations(fixture: ReturnType<typeof signedFixture>, nonce: string) {
  return {
    maker: signedBundle(CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
      fixture.document.makerSubjectRef, fixture.document, fixture.maker.privateKey, nonce),
    checker: signedBundle(CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
      fixture.document.checkerSubjectRef, fixture.document, fixture.checker.privateKey, nonce),
  };
}

function preflightInput(fixture: ReturnType<typeof signedFixture>) {
  return {
    document: fixture.document,
    secretDigests: { password: sha("1"), redemptionEntropy: sha("2") },
    makerAttestations: fixture.maker.bundle,
    makerPublicKey: fixture.maker.publicKey,
    checkerAttestations: fixture.checker.bundle,
    checkerPublicKey: fixture.checker.publicKey,
    certificationAuthority: fixture.certification.authority,
    now: NOW,
    environment: RUNTIME_ENVIRONMENT,
  } as const;
}

function prepared(
  fixture: ReturnType<typeof signedFixture>,
  secretDigests: Readonly<{ password: string; redemptionEntropy: string }>,
) {
  return prepareCoreSingleSiteBootstrapExecution({ ...preflightInput(fixture), secretDigests });
}

function recordingOwners(
  initial: CoreSingleSiteBootstrapExecution,
  crashAfter?: typeof CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS[number],
) {
  const calls: string[] = [];
  const committed = new Set<string>();
  const commitCounts = new Map<string, number>();
  let crashed = false;
  let claimedDigest: string | undefined;
  const commit = async (step: typeof CORE_SINGLE_SITE_BOOTSTRAP_EFFECT_STEPS[number],
    execution: CoreSingleSiteBootstrapExecution) => {
    calls.push(step);
    if (step === "configuration.claim") {
      if (claimedDigest !== undefined && claimedDigest !== execution.configDigest) {
        throw new Error("COMMAND_DIGEST_CONFLICT");
      }
      claimedDigest = execution.configDigest;
    }
    if (!committed.has(step)) {
      committed.add(step);
      commitCounts.set(step, 1);
      if (step === crashAfter && !crashed) {
        crashed = true;
        throw new Error(`CRASH_AFTER:${step}`);
      }
    }
  };
  const code = "KC1-AAAAAAAA-BBBBBBBBBB-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDD";
  const safeFingerprint = "CODE-0123456789ABCDEF";
  const owners: CoreSingleSiteBootstrapOwners = {
    configuration: {
      claim: (execution) => commit("configuration.claim", execution),
      complete: async (execution) => { await commit("configuration.complete", execution); },
    },
    site: {
      register: (execution) => commit("site.register", execution),
      publishRelease: (execution) => commit("site.publish-release", execution),
      requestActivationApproval: (execution) => commit("site.request-activation-approval", execution),
      approveAndActivate: (execution) => commit("site.approve-and-activate", execution),
      runOutboxCycle: (execution) => commit("site.run-outbox-cycle", execution),
    },
    capability: {
      ensureEmpty: (execution) => commit("capability.ensure-empty-catalog", execution),
    },
    model: {
      importInventory: (execution) => commit("model.import-inventory", execution),
      activateInventory: (execution) => commit("model.activate-inventory", execution),
      materializeOption: async (execution) => {
        await commit("model.materialize-option", execution);
        return execution.recipe.modelOptionRevisionRef;
      },
      publishSiteCatalog: async (execution) => {
        await commit("model.publish-site-catalog", execution);
        return execution.recipe.modelOptionCatalogRef;
      },
    },
    admission: {
      publishLaunchProfile: (execution) => commit("admission.publish-launch-profile", execution),
    },
    identity: {
      bootstrapVerifiedPersonal: (execution) => commit("identity.bootstrap-verified-personal", execution),
      runOutboxCycle: (execution) => commit("identity.run-outbox-cycle", execution),
    },
    rating: {
      publishPolicy: (execution) => commit("rating.publish-policy", execution),
    },
    commerce: {
      publishCreditProgram: (execution) => commit("commerce.publish-credit-program", execution),
      publishOffer: (execution) => commit("commerce.publish-offer", execution),
      publishRedemptionProgram: (execution) => commit("commerce.publish-redemption-program", execution),
      issueCodeBatch: async (execution) => {
        await commit("commerce.issue-code-batch", execution);
        return committed.has("commerce.issue-code-batch") ? null : code;
      },
      approveCodeBatch: (execution) => commit("commerce.approve-code-batch", execution),
      activateCodeBatch: (execution) => commit("commerce.activate-code-batch", execution),
      reconstructCode: () => ({
        code,
        safeFingerprint,
        keyRevision: "code-key-v1",
        batchSelector: "AAAAAAAAAA",
        lookupDigest: sha("9"),
      }),
    },
    readback: {
      assertReady: async (execution) => {
        await commit("readback.assert-ready", execution);
        return {
          deploymentRef: "deployment:core:1",
          code: {
            safeFingerprint,
            keyRevision: "code-key-v1",
            batchSelector: "AAAAAAAAAA",
            lookupDigest: sha("9"),
            state: "available",
          },
        };
      },
    },
  };
  void initial;
  return { owners, calls, committed, commitCounts, code, safeFingerprint };
}

const EMPTY_AGENT_CATALOG_REF = `agent-catalog:sha256:${capabilityCatalogSnapshotDigest({
  schemaVersion: 1,
  agentOptions: [],
  tools: [],
  skillOptions: [],
  mcpOptions: [],
  subagents: [],
})}`;
const RUNTIME_ENVIRONMENT = Object.freeze({
  PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: "https://direct-model.internal/v1",
});

function safeResult(): CoreSingleSiteBootstrapResult {
  return {
    schemaVersion: 1,
    kind: "kokoro-core-single-site-bootstrap-result",
    bootstrapId: uuid("1"),
    configDigest: sha("a"),
    site: {
      siteId: "site:core", siteReleaseRef: "site-release:core:1",
      webArtifactDigest: sha("b"), deploymentRef: "deployment:core:1", state: "active",
    },
    model: {
      inventoryDigest: sha("c"), modelOptionRevisionRef: `model-option:sha256:${sha("d")}`,
      modelOptionCatalogRef: `site-release-model-catalog:sha256:${sha("e")}`,
    },
    identity: {
      accountRef: uuid("3"), subjectRef: "subject:core-owner", workspaceRef: "workspace:core-owner",
      projectRef: "project:core-owner", billingAccountRef: "billing:core-owner",
      executionSpaceRef: "execution-space:core-owner", executionNamespace: "namespace_core_owner_00000000000000",
    },
    ratingPolicyRevisionRef: "rating-policy:core:1",
    agentCatalogRef: `agent-catalog:sha256:${sha("f")}`,
    redemption: {
      creditProgramRevisionRef: "credit-program:core:1",
      productVersionRef: "product:core-credit:1",
      fulfillmentProgramRevisionRef: "fulfillment:core-credit:1",
      programRevisionRef: "redemption-program:core:1",
      batchRef: uuid("2"),
      amount: "250000",
      unit: "credit",
      safeCodeFingerprint: "CODE-0123456789ABCDEF",
      state: "active",
    },
  };
}

function persistedCode(
  state: "available" | "claimed" | "void" = "available",
) {
  return {
    safeFingerprint: "CODE-0123456789ABCDEF",
    keyRevision: "code-key-v1",
    batchSelector: "AAAAAAAAAA",
    lookupDigest: sha("9"),
    state,
  } as const;
}
