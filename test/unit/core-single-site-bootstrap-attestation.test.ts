import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCoreBootstrapAdminAttestation } from "../../src/process/core-single-site-bootstrap-attestation.js";
import type { RequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";

describe("core bootstrap signed admin attestation", () => {
  it("binds the configured operator and exact operation", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const context = { requestId:"r",correlationId:"c",trustedCaller:{workloadIdentityId:"spiffe://kokoro/admin/bootstrap",kind:"admin_workload",audience:"platform-admin",environment:"production",region:"us-east-1",allowedOperations:["site.register"],siteId:"site:core",bindingEpoch:"1",issuedAt:"2026-08-11T00:00:00.000Z",expiresAt:"2026-08-12T00:00:00.000Z"},actor:{kind:"operator",subjectId:"operator:maker",subjectGeneration:"1"},delegatedGrant:null,target:{siteId:"site:core",workspaceId:null,projectId:null,purpose:"bootstrap",scopes:["site:core"]},audience:"platform-admin",environment:"production",region:"us-east-1",evidence:[{kind:"signature",evidenceId:"e",issuer:"bootstrap"}],policyEpoch:"1",issuedAt:"2026-08-11T00:00:00.000Z",expiresAt:"2026-08-12T00:00:00.000Z"} satisfies RequestSecurityContext;
    const signature=sign(null,Buffer.from(JSON.stringify(context)),privateKey).toString("base64");
    await expect(verifyCoreBootstrapAdminAttestation({envelope:{context,signature,keyVersion:"1"},publicKey,operation:"site.register",operatorRef:"operator:maker",now:"2026-08-11T01:00:00.000Z",audience:"platform-admin",environment:"production",region:"us-east-1"})).resolves.toMatchObject({actor:{subjectId:"operator:maker"}});
  });
});
