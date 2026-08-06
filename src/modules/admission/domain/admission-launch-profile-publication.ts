import { createHash } from "node:crypto";
import { z } from "zod";

const reference = z.string().min(1).max(256).refine((value) => value.trim() === value);
const permissionsSchema = z.object({
  approval_tools: z.array(reference).max(256),
  review_tools: z.array(reference).max(256),
  subagent_create: z.enum(["deny", "ask", "allow"]),
  filesystem: z.enum(["read_only", "workspace_write"]),
}).strict();

export const admissionLaunchProfileSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  siteId: reference,
  siteReleaseRef: reference,
  backend: z.enum(["state", "local_shell", "docker", "e2b", "custom"]),
  permissions: permissionsSchema,
  billing: z.object({
    unit: reference,
    liabilityMerchantAccountRef: reference,
    ratingPolicyRevisionRef: reference,
    rootCeiling: z.string().regex(/^[1-9][0-9]{0,38}$/u),
    segmentMaximum: z.string().regex(/^[1-9][0-9]{0,38}$/u),
    surfaceRef: reference,
    capabilityKey: reference,
  }).strict(),
}).strict();

export type AdmissionLaunchProfileSnapshot = Readonly<
  z.infer<typeof admissionLaunchProfileSnapshotSchema>
>;

export type PublishedAdmissionLaunchProfile = Readonly<{
  siteId: string;
  siteReleaseRef: string;
  launchProfileRef: string;
  snapshotDigest: string;
  snapshot: AdmissionLaunchProfileSnapshot;
  publishedAt: string;
}>;

export function defineAdmissionLaunchProfilePublication(input: Readonly<{
  siteId: string;
  siteReleaseRef: string;
  snapshot: AdmissionLaunchProfileSnapshot;
  publishedAt: string;
}>): PublishedAdmissionLaunchProfile {
  const snapshot = deepFreeze(admissionLaunchProfileSnapshotSchema.parse(input.snapshot));
  if (snapshot.siteId !== input.siteId || snapshot.siteReleaseRef !== input.siteReleaseRef) {
    throw new Error("ADMISSION_LAUNCH_PROFILE_SITE_BINDING_INVALID");
  }
  const publishedAt = instant(input.publishedAt);
  const snapshotDigest = createHash("sha256")
    .update(canonicalAdmissionLaunchProfileJson(snapshot), "utf8").digest("hex");
  return deepFreeze({
    siteId: snapshot.siteId,
    siteReleaseRef: snapshot.siteReleaseRef,
    launchProfileRef: `launch-profile:sha256:${snapshotDigest}`,
    snapshotDigest,
    snapshot,
    publishedAt,
  });
}

export function canonicalAdmissionLaunchProfileJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAdmissionLaunchProfileJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAdmissionLaunchProfileJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function instant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("ADMISSION_LAUNCH_PROFILE_PUBLICATION_TIME_INVALID");
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
