import { createHash } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import { canonicalCommandId } from "../../../shared/outbox-inbox/receipt.js";
import type { SiteAuthorityCommand } from "./contracts/site-authority-ports.js";

export function createSiteAuthorityCommand(
  operation: string,
  siteRef: string,
  input: Readonly<{ commandId: string; idempotencyKey: string }>,
  context: VerifiedRequestSecurityContext,
  effect: Readonly<Record<string, unknown>>,
): SiteAuthorityCommand {
  const commandId = canonicalCommandId(input.commandId);
  if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 256) {
    throw new Error("SITE_IDEMPOTENCY_KEY_INVALID");
  }
  return Object.freeze({
    commandId,
    idempotencyKey: input.idempotencyKey,
    operation,
    siteRef,
    callerIdentity: context.trustedCaller.workloadIdentityId,
    environment: context.environment,
    region: context.region,
    requestDigest: createHash("sha256").update(stableJson({ operation, siteRef, effect })).digest("hex"),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
