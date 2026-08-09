import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import type { PlatformTransactionalDatabaseClient } from
  "../../../src/infrastructure/postgres/client.js";
import { createCommerceAdministrationComposition } from
  "../../../src/process/commerce-admin-composition.js";
import { verifyRequestSecurityContext, type VerifiedRequestSecurityContext } from
  "../../../src/shared/security-context/request-security-context.js";

const environment = "production";
const region = "us-east-1";
const adminAudience = "platform-admin";
const publicAudience = "platform-public";

export type CommerceComponentTiming = Readonly<{
  now: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type CommerceRedemptionFixture = Readonly<{
  siteId: string;
  siteReleaseRef: string;
  publicWorkloadIdentityRef: string;
  subjectRef: string;
  sessionRef: string;
  billingAccountRef: string;
  productVersionRef: string;
  rawCodes: readonly string[];
  commandIds: string[];
  timing: CommerceComponentTiming;
  secretsPath: string;
  removeSecrets(): Promise<void>;
}>;

type AdminOperation =
  | "commerce.credit-program.publish"
  | "commerce.offer.publish"
  | "commerce.redemption-program.publish"
  | "commerce.code-batch.issue"
  | "commerce.code-batch.approve"
  | "commerce.code-batch.activate";

export type CommercePublicOperation =
  | "previewRedemption"
  | "confirmRedemption"
  | "recoverRedemptionCommand"
  | "getRedemptionReceipt"
  | "getCreditGrant"
  | "getCreditSummary"
  | "listAccountProducts";

export async function provisionCommerceRedemptionFixture(input: Readonly<{
  bootstrap: Client;
  admin: PlatformTransactionalDatabaseClient;
  maxRedemptionsPerAccount?: number;
}>): Promise<CommerceRedemptionFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const siteId = `site:redeem:${suffix}`;
  const siteReleaseRef = `release:redeem:${suffix}`;
  const publicWorkloadIdentityRef = `spiffe://kokoro.test/site/redeem-${suffix}`;
  const adminWorkloadIdentityRef = `spiffe://kokoro.test/admin/redeem-${suffix}`;
  const subjectRef = `subject:redeem:${suffix}`;
  const sessionRef = `session:redeem:${suffix}`;
  const billingAccountRef = `billing:redeem:${suffix}`;
  const creditProgramRevisionRef = `credit-program-revision:${suffix}`;
  const productVersionRef = `offer:${suffix}:credit-pack`;
  const fulfillmentProgramRevisionRef = `fulfillment-program:${suffix}`;
  const redemptionProgramRevisionRef = `redemption-program-revision:${suffix}`;
  const batchRef = randomUUID();
  const timing = requestTiming();
  const commandIds: string[] = [];
  const secrets = await keyRing();
  const maker = `operator:redeem:maker:${suffix}`;
  const checker = `operator:redeem:checker:${suffix}`;
  try {
    await bootstrapAuthority(input.bootstrap, {
      siteId, siteReleaseRef, workloadIdentityRef: publicWorkloadIdentityRef,
      subjectRef, sessionRef, billingAccountRef,
      credentialDigest: createHash("sha256").update(sessionRef, "utf8").digest("hex"), timing,
    });
    const production = await createCommerceAdministrationComposition({
      database: input.admin,
      environment: { PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: secrets.path },
    });
    const command = async (actorRef: string, generation: string, operation: AdminOperation) => {
      const commandId = randomUUID(); commandIds.push(commandId);
      return Object.freeze({
        context: await adminContext({ timing, siteId, actorRef, generation,
          workloadIdentityRef: adminWorkloadIdentityRef }, operation),
        siteId,
        commandId,
        idempotencyKey: `commerce-component-${commandId}`,
      });
    };

    await production.commerce.publishCreditProgramRevision({
      ...await command(maker, "11", "commerce.credit-program.publish"),
      creditProgramRevisionRef,
      programRef: `credit-program:${suffix}`,
      revision: "1",
      uxBucketClass: "permanent",
      unit: "credit_minor",
      amount: "1000",
      burnPriority: 10,
      scopePolicy: { surfaceRefs: ["chat"], capabilityKeys: ["chat.generate"],
        agentRefs: [], allowUnattributedAgent: true },
      liabilityMerchantAccountRef: "merchant:platform",
      rolloverPolicy: "none",
      calendarZone: null,
      windowAnchor: null,
      expiresAfterSeconds: null,
    });
    await production.commerce.publishOffer({
      ...await command(maker, "11", "commerce.offer.publish"),
      productRef: `product:${suffix}:credit-pack`,
      productKind: "credit_pack",
      productVersionRef,
      productRevision: "1",
      safeLabel: "Component 1,000 credit pack",
      planVersion: null,
      fulfillmentProgramRevisionRef,
      fulfillmentProgramRef: `fulfillment:${suffix}`,
      fulfillmentProgramRevision: "1",
      outputs: [{ outputLineId: "credits", ordinal: 1, cardinality: 1,
        outputKind: "credit_grant", targetRevisionRef: creditProgramRevisionRef }],
      legalTermRefs: [],
    });
    await production.commerce.publishProgram({
      ...await command(maker, "11", "commerce.redemption-program.publish"),
      redemptionProgramRevisionRef,
      programRef: `redemption-program:${suffix}`,
      revision: "1",
      productVersionRef,
      fulfillmentProgramRevisionRef,
      maxRedemptionsPerAccount: input.maxRedemptionsPerAccount ?? 2,
    });
    const delivery = await production.commerce.issueBatch({
      ...await command(maker, "11", "commerce.code-batch.issue"),
      batchRef,
      redemptionProgramRevisionRef,
      count: 2,
      startsAt: null,
      endsAt: null,
    });
    if (delivery.kind !== "secret_export" || delivery.codes.length !== 2) {
      throw new Error("COMMERCE_COMPONENT_CODE_EXPORT_REQUIRED");
    }
    await production.commerce.approveBatch({
      ...await command(checker, "7", "commerce.code-batch.approve"),
      batchRef,
    });
    await production.commerce.activateBatch({
      ...await command(checker, "7", "commerce.code-batch.activate"),
      batchRef,
    });
    return Object.freeze({ siteId, siteReleaseRef, publicWorkloadIdentityRef, subjectRef,
      sessionRef, billingAccountRef, productVersionRef,
      rawCodes: Object.freeze([...delivery.codes]), commandIds, timing,
      secretsPath: secrets.path, removeSecrets: secrets.remove });
  } catch (error) {
    await secrets.remove();
    throw error;
  }
}

export async function commercePublicContext(
  fixture: CommerceRedemptionFixture,
  operation: CommercePublicOperation,
): Promise<VerifiedRequestSecurityContext> {
  const issuer = "spiffe://kokoro.test/site/commerce-component-ca";
  const caller = Object.freeze({ workloadIdentityId: fixture.publicWorkloadIdentityRef,
    kind: "site_product" as const, audience: publicAudience, environment, region,
    allowedOperations: [operation], siteId: fixture.siteId, siteReleaseRef: fixture.siteReleaseRef,
    siteSecurityEpoch: "1", bindingEpoch: "1", issuedAt: fixture.timing.issuedAt,
    expiresAt: fixture.timing.expiresAt, issuer, keyVersion: "component-1" });
  return verifyRequestSecurityContext({ requestId: randomUUID(), correlationId: randomUUID(),
    trustedCaller: { kind: caller.kind, workloadIdentityId: caller.workloadIdentityId,
      siteId: caller.siteId, siteReleaseRef: caller.siteReleaseRef,
      siteSecurityEpoch: caller.siteSecurityEpoch, audience: publicAudience, environment, region,
      allowedOperations: caller.allowedOperations, bindingEpoch: caller.bindingEpoch,
      issuedAt: caller.issuedAt, expiresAt: caller.expiresAt },
    actor: { kind: "user", subjectId: fixture.subjectRef, subjectGeneration: "1",
      sessionId: fixture.sessionRef, sessionEpoch: "1", restrictionEpoch: "1" },
    delegatedGrant: null,
    target: { siteId: fixture.siteId, workspaceId: null, projectId: null,
      purpose: operation, scopes: [] }, audience: publicAudience, environment, region,
    evidence: [
      { kind: "csrf_verification", evidenceId: "c".repeat(64), issuer: "kokoro-platform-public" },
      { kind: "workload_attestation", evidenceId: `commerce:${fixture.siteId}`, issuer },
    ], policyEpoch: "1", issuedAt: fixture.timing.issuedAt,
    expiresAt: fixture.timing.expiresAt }, {
    now: fixture.timing.now, operation, expectedAudience: publicAudience,
    expectedEnvironment: environment, expectedRegion: region,
    callerVerifier: { verify: async () => caller },
  });
}

export async function cleanupCommerceRedemptionFixture(
  bootstrap: Client,
  fixture: CommerceRedemptionFixture,
): Promise<void> {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role='replica'");
    for (const relation of [
      "commerce_fulfillment_actual_output", "commerce_fulfillment_output_plan",
    ]) {
      await bootstrap.query(
        `DELETE FROM platform.${relation} WHERE fulfillment_id IN (
           SELECT fulfillment_id FROM platform.commerce_fulfillment_transaction WHERE site_ref=$1
         )`, [fixture.siteId],
      );
    }
    await bootstrap.query(
      "DELETE FROM platform.commerce_command_outbox WHERE command_id=ANY($1::text[])",
      [fixture.commandIds],
    );
    await bootstrap.query(
      "DELETE FROM platform.outbox_event WHERE correlation_id=ANY($1::text[])",
      [fixture.commandIds],
    );
    for (const relation of [
      "commerce_redemption_legal_acceptance", "commerce_redemption_preview", "commerce_redemption",
      "credit_journal_entry", "credit_journal_transaction", "credit_grant", "credit_account",
      "commerce_fulfillment_transaction", "commerce_redeem_code", "commerce_code_batch_approval",
      "commerce_code_secret_export", "commerce_code_batch", "commerce_redemption_program_availability",
      "commerce_redemption_program_revision", "commerce_catalog_product_version",
      "commerce_fulfillment_program_output", "commerce_fulfillment_program_revision",
      "commerce_credit_program_revision", "commerce_catalog_product", "commerce_audit_entry",
      "commerce_billing_account_membership", "commerce_billing_account", "commerce_command",
    ]) {
      await bootstrap.query(`DELETE FROM platform.${relation} WHERE site_ref=$1`, [fixture.siteId]);
    }
    await bootstrap.query(
      "DELETE FROM platform.command_receipt WHERE command_id=ANY($1::text[])",
      [fixture.commandIds],
    );
    for (const relation of [
      "authorization_identity_session", "authorization_subject", "authorization_product_binding",
      "authorization_site_release", "authorization_site",
    ]) {
      await bootstrap.query(`DELETE FROM platform.${relation} WHERE site_ref=$1`, [fixture.siteId]);
    }
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}

async function adminContext(
  fixture: Readonly<{ timing: CommerceComponentTiming; siteId: string; actorRef: string;
    generation: string; workloadIdentityRef: string }>,
  operation: AdminOperation,
): Promise<VerifiedRequestSecurityContext> {
  const issuer = "spiffe://kokoro.test/admin/commerce-component-ca";
  const caller = Object.freeze({ workloadIdentityId: fixture.workloadIdentityRef,
    kind: "admin_workload" as const, audience: adminAudience, environment, region,
    allowedOperations: [operation], siteId: null, bindingEpoch: "1",
    issuedAt: fixture.timing.issuedAt, expiresAt: fixture.timing.expiresAt,
    issuer, keyVersion: "component-1" });
  return verifyRequestSecurityContext({ requestId: randomUUID(), correlationId: randomUUID(),
    trustedCaller: { kind: caller.kind, workloadIdentityId: caller.workloadIdentityId,
      audience: adminAudience, environment, region, allowedOperations: caller.allowedOperations,
      bindingEpoch: caller.bindingEpoch, issuedAt: caller.issuedAt, expiresAt: caller.expiresAt },
    actor: { kind: "operator", subjectId: fixture.actorRef, subjectGeneration: fixture.generation },
    delegatedGrant: null,
    target: { siteId: fixture.siteId, workspaceId: null, projectId: null, purpose: operation,
      scopes: ["admin:site", operation] },
    audience: adminAudience, environment, region,
    evidence: [{ kind: "workload_attestation", evidenceId: `commerce:${fixture.actorRef}`, issuer }],
    policyEpoch: "1", issuedAt: fixture.timing.issuedAt, expiresAt: fixture.timing.expiresAt }, {
    now: fixture.timing.now, operation, expectedAudience: adminAudience,
    expectedEnvironment: environment, expectedRegion: region,
    callerVerifier: { verify: async () => caller },
  });
}

async function bootstrapAuthority(bootstrap: Client, fixture: Readonly<{
  siteId: string; siteReleaseRef: string; workloadIdentityRef: string; subjectRef: string;
  sessionRef: string; billingAccountRef: string; credentialDigest: string;
  timing: CommerceComponentTiming;
}>): Promise<void> {
  await bootstrap.query(
    `INSERT INTO platform.authorization_site(site_ref,state,security_epoch,policy_epoch,revocation_epoch)
     VALUES ($1,'active',1,1,1)`, [fixture.siteId],
  );
  await bootstrap.query(
    `INSERT INTO platform.authorization_site_release
       (release_ref,site_ref,state,web_artifact_digest,enabled_surface_ids,feature_policy_revision,
        model_option_catalog_ref,agent_catalog_ref,identity_issuer_label,
        identity_auth_strength_policy_revision,locale_policy)
     VALUES ($1,$2,'active',$3,'[]'::jsonb,$4,$5,$6,'Kokoro','identity-v1','{}'::jsonb)`,
    [fixture.siteReleaseRef, fixture.siteId, "a".repeat(64), `features:${fixture.siteId}`,
      `models:${fixture.siteId}`, `agents:${fixture.siteId}`],
  );
  await bootstrap.query(
    `INSERT INTO platform.authorization_product_binding
       (binding_ref,workload_identity_id,deployment_ref,site_ref,release_ref,environment,region,
        audience,session_contract_revision,binding_epoch,state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'session-v1',1,'active')`,
    [`binding:${fixture.siteId}`, fixture.workloadIdentityRef, `deployment:${fixture.siteId}`,
      fixture.siteId, fixture.siteReleaseRef, environment, region, publicAudience],
  );
  await bootstrap.query(
    `INSERT INTO platform.authorization_subject
       (subject_ref,site_ref,display_name,state,subject_generation,restriction_epoch)
     VALUES ($1,$2,'Commerce component user','active',1,1)`, [fixture.subjectRef, fixture.siteId],
  );
  await bootstrap.query(
    `INSERT INTO platform.authorization_identity_session
       (session_ref,subject_ref,site_ref,credential_digest,authentication_methods,state,
        session_epoch,credential_epoch,authenticated_at,expires_at,device_label,last_seen_at)
     VALUES ($1,$2,$3,$4,ARRAY['password']::text[],'active',1,1,$5::timestamptz,$6::timestamptz,
             'Commerce component device',$5::timestamptz)`,
    [fixture.sessionRef, fixture.subjectRef, fixture.siteId, fixture.credentialDigest,
      fixture.timing.issuedAt, fixture.timing.expiresAt],
  );
  await bootstrap.query(
    `INSERT INTO platform.commerce_billing_account(billing_account_ref,site_ref,state)
     VALUES ($1,$2,'active')`, [fixture.billingAccountRef, fixture.siteId],
  );
  await bootstrap.query(
    `INSERT INTO platform.commerce_billing_account_membership
       (billing_account_ref,site_ref,subject_ref,subject_generation,state,membership_epoch,is_default)
     VALUES ($1,$2,$3,1,'active',1,true)`,
    [fixture.billingAccountRef, fixture.siteId, fixture.subjectRef],
  );
}

function requestTiming(): CommerceComponentTiming {
  const now = new Date();
  return Object.freeze({ now: now.toISOString(),
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 600_000).toISOString() });
}

async function keyRing(): Promise<Readonly<{ path: string; remove(): Promise<void> }>> {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-commerce-redemption-component-"));
  const path = join(directory, "redemption-keyring.json");
  const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
  await writeFile(path, JSON.stringify({ version: 1,
    currentCodeLookupKeyRevision: "component-code-v1",
    codeLookupKeys: [{ keyRevision: "component-code-v1", keyBase64url: secret(1) }],
    currentPreviewCredentialKeyRevision: "component-preview-v1",
    previewCredentialKeys: [{ keyRevision: "component-preview-v1", keyBase64url: secret(2) }],
    requestAuditKeyBase64url: secret(3),
  }), { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ path, remove: () => rm(directory, { recursive: true, force: true }) });
}
