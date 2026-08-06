import { createHash } from "node:crypto";
import { z } from "zod";
import { AdmissionRetryClass } from "../../../../generated/proto/kokoro/platform/admission/v1/admission_pb.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdmissionCapabilityOwnerPort,
  AdmissionOwnerResolution,
  AdmissionRuntimePolicyOwnerPort,
} from "../../application/platform-admission-owner-authority.js";
import { admissionLaunchProfileSnapshotSchema } from
  "../../domain/admission-launch-profile-publication.js";

const reference = z.string().min(1).max(256).refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const capabilityCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  agentOptions: z.array(z.object({
    optionRef: reference,
    agent: reference,
    label: z.string().min(1).max(128),
  }).strict()).max(64),
  defaultAgentOptionRef: reference.optional(),
  tools: z.array(reference).max(256),
  skillOptions: z.array(z.object({
    optionRef: reference,
    label: z.string().min(1).max(128),
    name: reference,
    contentHash: digest,
    description: z.string().min(1).max(2_048),
    scope: reference,
    prerequisiteRef: reference.optional(),
  }).strict()).max(256),
  mcpOptions: z.array(z.object({
    optionRef: reference,
    label: z.string().min(1).max(128),
    scope: reference,
    name: reference,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    configHash: digest,
    prerequisiteRef: reference.optional(),
  }).strict()).max(256),
  subagents: z.array(reference).max(64),
}).strict();

interface SnapshotRow extends Record<string, unknown> {
  readonly siteId: unknown;
  readonly siteReleaseRef: unknown;
  readonly launchProfileRef?: unknown;
  readonly agentCatalogRef?: unknown;
  readonly snapshotDigest: unknown;
  readonly payload: unknown;
}

type RuntimeResolution = Awaited<ReturnType<AdmissionRuntimePolicyOwnerPort["resolve"]>>;
type CapabilityResolution = Awaited<ReturnType<AdmissionCapabilityOwnerPort["resolve"]>>;

/** Reads an immutable launch profile already published with the exact SiteRelease. */
export class PostgresAdmissionRuntimePolicyOwner implements AdmissionRuntimePolicyOwnerPort {
  async resolve(
    transaction: Parameters<AdmissionRuntimePolicyOwnerPort["resolve"]>[0],
    input: Parameters<AdmissionRuntimePolicyOwnerPort["resolve"]>[1],
  ): Promise<RuntimeResolution> {
    const rows = await resolvePlatformTransaction(transaction).query<SnapshotRow>(
      `SELECT profile.site_ref AS "siteId",profile.site_release_ref AS "siteReleaseRef",
              profile.launch_profile_ref AS "launchProfileRef",
              profile.snapshot_digest AS "snapshotDigest",profile.snapshot AS payload
         FROM platform.admission_launch_profile_snapshot AS profile
         JOIN platform.site_release AS release
           ON release.site_ref=profile.site_ref
          AND release.release_ref=profile.site_release_ref
          AND release.launch_profile_ref=profile.launch_profile_ref
        WHERE profile.site_ref=$1 AND profile.site_release_ref=$2
          AND release.state='active'
        LIMIT 1`,
      [input.siteId, input.configurationRevisionId],
    );
    const row = single(rows, "ADMISSION_LAUNCH_PROFILE_OWNER_CORRUPT");
    if (row === undefined) return denied("ADMISSION_LAUNCH_PROFILE_NOT_AVAILABLE");
    const parsed = admissionLaunchProfileSnapshotSchema.safeParse(row.payload);
    if (
      !parsed.success || row.siteId !== input.siteId || row.siteReleaseRef !== input.configurationRevisionId ||
      parsed.data.siteId !== input.siteId || parsed.data.siteReleaseRef !== input.configurationRevisionId ||
      typeof row.snapshotDigest !== "string" || digestValue(parsed.data) !== row.snapshotDigest ||
      row.launchProfileRef !== `launch-profile:sha256:${row.snapshotDigest}` ||
      BigInt(parsed.data.billing.segmentMaximum) > BigInt(parsed.data.billing.rootCeiling)
    ) throw new Error("ADMISSION_LAUNCH_PROFILE_OWNER_CORRUPT");
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({
        backend: parsed.data.backend,
        permissions: {
          ...parsed.data.permissions,
          approval_tools: [...parsed.data.permissions.approval_tools],
          review_tools: [...parsed.data.permissions.review_tools],
        },
      }),
    });
  }
}

/** Resolves a SiteRelease-pinned Hub publication without putting Hub on the launch hot path. */
export class PostgresAdmissionCapabilityOwner implements AdmissionCapabilityOwnerPort {
  async resolve(
    transaction: Parameters<AdmissionCapabilityOwnerPort["resolve"]>[0],
    input: Parameters<AdmissionCapabilityOwnerPort["resolve"]>[1],
  ): Promise<CapabilityResolution> {
    const rows = await resolvePlatformTransaction(transaction).query<SnapshotRow>(
      `SELECT catalog.site_ref AS "siteId",catalog.site_release_ref AS "siteReleaseRef",
              catalog.agent_catalog_ref AS "agentCatalogRef",
              catalog.snapshot_digest AS "snapshotDigest",catalog.snapshot AS payload
         FROM platform.admission_capability_catalog_snapshot AS catalog
         JOIN platform.site_release AS release
           ON release.site_ref=catalog.site_ref
          AND release.release_ref=catalog.site_release_ref
          AND release.agent_catalog_ref=catalog.agent_catalog_ref
        WHERE catalog.site_ref=$1 AND catalog.site_release_ref=$2
          AND release.state='active'
        LIMIT 1`,
      [input.siteId, input.configurationRevisionId],
    );
    const row = single(rows, "ADMISSION_CAPABILITY_OWNER_CORRUPT");
    if (row === undefined) return denied("ADMISSION_CAPABILITY_CATALOG_NOT_AVAILABLE");
    const parsed = capabilityCatalogSchema.safeParse(row.payload);
    if (
      !parsed.success || row.siteId !== input.siteId || row.siteReleaseRef !== input.configurationRevisionId ||
      typeof row.agentCatalogRef !== "string" || !reference.safeParse(row.agentCatalogRef).success ||
      typeof row.snapshotDigest !== "string" || digestValue(parsed.data) !== row.snapshotDigest ||
      duplicate(parsed.data.agentOptions.map((item) => item.optionRef)) ||
      duplicate(parsed.data.skillOptions.map((item) => item.optionRef)) ||
      duplicate(parsed.data.mcpOptions.map((item) => item.optionRef)) ||
      duplicate(parsed.data.tools) || duplicate(parsed.data.subagents) ||
      (parsed.data.defaultAgentOptionRef !== undefined &&
        !parsed.data.agentOptions.some((item) => item.optionRef === parsed.data.defaultAgentOptionRef))
    ) throw new Error("ADMISSION_CAPABILITY_OWNER_CORRUPT");

    const agentRef = input.requestedAgentOptionRef ?? parsed.data.defaultAgentOptionRef;
    const agent = agentRef === undefined
      ? undefined
      : parsed.data.agentOptions.find((item) => item.optionRef === agentRef);
    if (agentRef !== undefined && agent === undefined) return denied("ADMISSION_AGENT_OPTION_NOT_ALLOWED");
    if (duplicate(input.requestedSkillOptionRefs) || duplicate(input.requestedMcpOptionRefs)) {
      return denied("ADMISSION_CAPABILITY_SELECTION_INVALID");
    }
    const requestedSkills = new Set(input.requestedSkillOptionRefs);
    const requestedMcp = new Set(input.requestedMcpOptionRefs);
    const skills = parsed.data.skillOptions.filter((item) => requestedSkills.has(item.optionRef));
    const mcp = parsed.data.mcpOptions.filter((item) => requestedMcp.has(item.optionRef));
    if (skills.length !== requestedSkills.size) return denied("ADMISSION_SKILL_OPTION_NOT_ALLOWED");
    if (mcp.length !== requestedMcp.size) return denied("ADMISSION_MCP_OPTION_NOT_ALLOWED");
    const selection = Object.freeze({
      agentCatalogRef: row.agentCatalogRef,
      catalogDigest: row.snapshotDigest,
      ...(agent === undefined ? {} : { agentOptionRef: agent.optionRef }),
      skillOptionRefs: skills.map((item) => item.optionRef),
      mcpOptionRefs: mcp.map((item) => item.optionRef),
    });
    const prerequisites = [...skills, ...mcp]
      .flatMap((item) => item.prerequisiteRef === undefined ? [] : [item.prerequisiteRef]);
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({
        capabilitySnapshotRef: `capability-snapshot:sha256:${digestValue(selection)}`,
        agentCatalogRef: row.agentCatalogRef,
        ...(agent === undefined ? {} : { agent: agent.agent, agentLabel: agent.label }),
        tools: Object.freeze([...parsed.data.tools]),
        skills: Object.freeze(skills.map((item) => Object.freeze({
          option_ref: item.optionRef,
          name: item.name,
          content_hash: item.contentHash,
          description: item.description,
          scope: item.scope,
        }))),
        mcpServers: Object.freeze(mcp.map((item) => Object.freeze({
          option_ref: item.optionRef,
          scope: item.scope,
          name: item.name,
          revision: item.revision,
          config_hash: item.configHash,
        }))),
        subagents: Object.freeze([...parsed.data.subagents]),
        safeCapabilities: Object.freeze([
          ...skills.map((item) => Object.freeze({ kind: "skill" as const, label: item.label })),
          ...mcp.map((item) => Object.freeze({ kind: "mcp" as const, label: item.label })),
        ]),
        prerequisiteRefs: Object.freeze([...new Set(prerequisites)]),
      }),
    });
  }
}

function single(rows: readonly SnapshotRow[], code: string): SnapshotRow | undefined {
  if (rows.length > 1) throw new Error(code);
  return rows[0];
}

function denied(code: string): AdmissionOwnerResolution<never> {
  return Object.freeze({
    kind: "denied",
    denial: Object.freeze({ code, retryClass: AdmissionRetryClass.NEVER }),
  });
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
