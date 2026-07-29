import { domainToASCII } from "node:url";

const MAX_NORMALIZED_EMAIL_LENGTH = 191;
const MAX_DOMAIN_LENGTH = 253;
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function invalidIdentityEmail(): never {
  throw new Error("IDENTITY_EMAIL_INVALID");
}

/**
 * Canonicalizes the login identifier used by Platform Identity.
 *
 * This is deliberately a product identity policy, not an RFC mailbox parser:
 * quoted local parts and non-ASCII local parts are rejected so every runtime
 * and datastore derives the same Site-scoped uniqueness key.
 */
export function normalizeIdentityEmail(input: string): string {
  const candidate = input.trim().normalize("NFKC");
  const separator = candidate.indexOf("@");
  if (separator <= 0 || separator !== candidate.lastIndexOf("@")) {
    return invalidIdentityEmail();
  }

  const local = candidate.slice(0, separator).toLowerCase();
  const unicodeDomain = candidate.slice(separator + 1);
  const domain = domainToASCII(unicodeDomain).toLowerCase();
  const labels = domain.split(".");

  if (
    local.length > 64 ||
    !LOCAL_PART.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length === 0 ||
    domain.length > MAX_DOMAIN_LENGTH ||
    labels.some((label) => !DOMAIN_LABEL.test(label))
  ) {
    return invalidIdentityEmail();
  }

  const normalized = `${local}@${domain}`;
  if (normalized.length > MAX_NORMALIZED_EMAIL_LENGTH) {
    return invalidIdentityEmail();
  }
  return normalized;
}
