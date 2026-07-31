import { z } from "zod";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  MediaPublicDefinitionRecord,
  MediaPublicModelOptionRecord,
  MediaPublicOperationRecord,
  MediaPublicOwnerAuthorityAssertion,
  MediaPublicReadRepository,
  ResolvedMediaPublicOwnerAuthority,
} from "../../application/contracts/media-public-read-ports.js";

const reference = z.string().min(1).max(256).refine((value) => value.trim() === value && !/[\0\r\n]/u.test(value));
const instant = z.preprocess((value) => value instanceof Date ? value.toISOString() : value,
  z.string().refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  }));
const positiveBigint = z.preprocess((value) => typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
  ? BigInt(value) : value, z.bigint().positive().max(9_223_372_036_854_775_807n));
const nonNegativeBigint = z.preprocess((value) => typeof value === "string" && /^[0-9]+$/u.test(value)
  ? BigInt(value) : value, z.bigint().nonnegative());

const authorityRowSchema = z.strictObject({
  membershipEpoch: positiveBigint,
  authorizationEpoch: positiveBigint,
  modelOptionCatalogRef: reference,
});
const aspectRatioSchema = z.enum([
  "square_1_1", "landscape_4_3", "landscape_16_9", "portrait_3_4", "portrait_9_16",
]);
const outputFormatSchema = z.enum(["png", "jpeg", "webp"]);
const definitionRowSchema = z.strictObject({
  definitionKey: z.literal("image.text_to_image@v1"),
  definitionRevisionRef: reference,
  mediaKind: z.literal("image_text_to_image"),
  maximumCandidateCount: z.number().int().min(1).max(4),
  promptMaximumUtf8Bytes: z.literal(32768),
  supportedAspectRatios: z.array(aspectRatioSchema).min(1).max(5)
    .refine((values) => new Set(values).size === values.length),
  supportedOutputFormats: z.array(outputFormatSchema).min(1).max(3)
    .refine((values) => new Set(values).size === values.length),
  publishedAt: instant,
  modelOptionCatalogRevisionRef: reference,
});
const optionRowSchema = z.strictObject({
  definitionRevisionRef: reference,
  position: z.number().int().min(0).max(255),
  modelOptionRevisionRef: reference,
  optionKey: z.string().min(2).max(128).regex(/^[a-z][a-z0-9._-]+$/u),
  label: z.string().min(1).max(128).refine(safeText),
  description: z.string().max(512).refine(safeText).nullable(),
  inputModalities: z.array(z.string().min(1).max(64)).min(1).max(16),
  outputModalities: z.array(z.string().min(1).max(64)).min(1).max(16),
  supportedEfforts: z.array(z.string().min(1).max(64)).max(16),
  badges: z.array(z.string().min(1).max(64)).max(16),
  availability: z.enum(["available", "temporarily_unavailable"]),
});
const candidateSchema = z.strictObject({
  candidateRef: reference,
  ordinal: z.number().int().min(1).max(16),
  ownerVersion: positiveBigint,
  state: z.enum(["allocated", "producing", "output_received", "validating", "ready",
    "restricted", "failed", "unknown", "cancel_requested", "canceled"]),
  artifactRef: reference,
  artifactVersionRef: reference,
});
const operationRowSchema = z.strictObject({
  operationRef: reference,
  definitionKey: z.literal("image.text_to_image@v1"),
  definitionRevisionRef: reference,
  modelOptionRevisionRef: reference,
  state: z.enum(["admission_pending", "authorized", "queued", "active", "finalizing",
    "cancel_requested", "reconciling", "completed", "partial", "failed", "canceled"]),
  outcomeClass: z.enum(["canonical", "irreconcilable"]).nullable(),
  ownerVersion: positiveBigint,
  terminalFailure: z.record(z.string(), z.unknown()).nullable(),
  financialReceiptRef: reference.nullable(),
  actualCost: nonNegativeBigint.nullable(),
  terminalCreditUnit: z.string().min(1).max(64).nullable(),
  createdAt: instant,
  updatedAt: instant,
  candidates: z.array(candidateSchema).max(16),
}).superRefine((row, context) => {
  const terminal = ["completed", "partial", "failed", "canceled"].includes(row.state);
  if (terminal !== (row.outcomeClass !== null) || (row.state === "failed") !== (row.terminalFailure !== null)) {
    context.addIssue({ code: "custom", message: "invalid terminal shape" });
  }
  const costParts = [row.financialReceiptRef, row.actualCost, row.terminalCreditUnit];
  if (!costParts.every((value) => value === null) && !costParts.every((value) => value !== null)) {
    context.addIssue({ code: "custom", message: "invalid cost shape" });
  }
});

/**
 * Prepared owner read adapter. It remains deliberately absent from production composition until a
 * migration grants the API role an owner-only SECURITY DEFINER query contract for these tables.
 */
export class PostgresMediaPublicReadRepository implements MediaPublicReadRepository {
  async resolveOwnerAuthority(transaction: PlatformTransaction, input: Readonly<{
    assertion: MediaPublicOwnerAuthorityAssertion;
    now: string;
  }>): Promise<ResolvedMediaPublicOwnerAuthority | null> {
    const a = input.assertion;
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT membership.membership_epoch AS "membershipEpoch",
              membership.authorization_epoch AS "authorizationEpoch",
              release.model_option_catalog_ref AS "modelOptionCatalogRef"
         FROM platform.authorization_product_binding AS binding
         JOIN platform.authorization_site AS site
           ON site.site_ref=binding.site_ref
          AND site.state='active'
          AND site.security_epoch=$7::bigint
          AND site.policy_epoch=$8::bigint
         JOIN platform.authorization_site_release AS release
           ON release.release_ref=binding.release_ref
          AND release.site_ref=binding.site_ref
          AND release.state='active'
         JOIN platform.authorization_identity_session AS identity_session
           ON identity_session.session_ref=$13
          AND identity_session.subject_ref=$11
          AND identity_session.site_ref=binding.site_ref
          AND identity_session.state='active'
          AND identity_session.session_epoch=$14::bigint
          AND identity_session.credential_epoch=$16::bigint
          AND identity_session.expires_at>$18::timestamptz
         JOIN platform.authorization_subject AS subject
           ON subject.subject_ref=identity_session.subject_ref
          AND subject.site_ref=identity_session.site_ref
          AND subject.state='active'
          AND subject.subject_generation=$12::bigint
          AND subject.restriction_epoch=$15::bigint
         JOIN platform.authorization_project AS project
           ON project.project_ref=$17
          AND project.site_ref=binding.site_ref
          AND project.state='active'
         JOIN platform.authorization_project_membership AS membership
           ON membership.project_ref=project.project_ref
          AND membership.subject_ref=subject.subject_ref
          AND membership.state='active'
        WHERE binding.binding_ref=$3
          AND binding.workload_identity_id=$5
          AND binding.deployment_ref=$4
          AND binding.site_ref=$1
          AND binding.release_ref=$2
          AND binding.binding_epoch=$6::bigint
          AND binding.environment=$9
          AND binding.region=$10
          AND binding.audience=$19
          AND binding.state='active'
        LIMIT 2
        FOR SHARE OF binding,site,release,identity_session,subject,project,membership`,
      [a.siteRef, a.siteReleaseRef, a.siteProjectBindingRef, a.deploymentRef,
        a.workloadIdentityRef, a.workloadBindingEpoch, a.siteSecurityEpoch, a.policyEpoch,
        a.environment, a.region, a.subjectRef, a.subjectGeneration, a.identitySessionRef,
        a.identitySessionEpoch, a.restrictionEpoch, a.credentialEpoch, a.projectRef, input.now,
        a.audience],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("MEDIA_PUBLIC_OWNER_AUTHORITY_CORRUPT");
    const row = parse(authorityRowSchema, rows[0], "MEDIA_PUBLIC_OWNER_AUTHORITY_CORRUPT");
    return Object.freeze({ ...a, ...row });
  }

  async listDefinitions(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    publishedBefore: string | null;
    definitionRevisionRefBefore: string | null;
    limit: number;
  }>): Promise<readonly MediaPublicDefinitionRecord[]> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `${DEFINITION_SELECT}
       WHERE publication.site_id=$1 AND publication.site_release_ref=$2
         AND publication.model_option_catalog_ref=$3
         AND ($4::timestamptz IS NULL OR
              (definition.published_at,revision.definition_revision_ref)<($4::timestamptz,$5::text))
       ORDER BY definition.published_at DESC,revision.definition_revision_ref DESC
       LIMIT $6`,
      [input.authority.siteRef, input.authority.siteReleaseRef, input.authority.modelOptionCatalogRef,
        input.publishedBefore, input.definitionRevisionRefBefore, input.limit],
    );
    return Object.freeze(rows.map((row) => parse(definitionRowSchema, row,
      "MEDIA_PUBLIC_DEFINITION_RECORD_CORRUPT")));
  }

  async getDefinition(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    definitionRef: string;
  }>): Promise<MediaPublicDefinitionRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `${DEFINITION_SELECT}
       WHERE publication.site_id=$1 AND publication.site_release_ref=$2
         AND publication.model_option_catalog_ref=$3 AND revision.definition_key=$4
       LIMIT 2`,
      [input.authority.siteRef, input.authority.siteReleaseRef, input.authority.modelOptionCatalogRef,
        input.definitionRef],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("MEDIA_PUBLIC_DEFINITION_RECORD_CORRUPT");
    return parse(definitionRowSchema, rows[0], "MEDIA_PUBLIC_DEFINITION_RECORD_CORRUPT");
  }

  async listModelOptions(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    definitionRef: string;
    positionAfter: number | null;
    modelOptionRevisionRefAfter: string | null;
    limit: number;
  }>): Promise<Readonly<{
    definitionRevisionRef: string;
    options: readonly MediaPublicModelOptionRecord[];
  }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT revision.definition_revision_ref AS "definitionRevisionRef",
              published.position,
              option.revision_ref AS "modelOptionRevisionRef",option.option_key AS "optionKey",
              option.label,option.description,option.input_modalities AS "inputModalities",
              option.output_modalities AS "outputModalities",
              option.supported_efforts AS "supportedEfforts",option.badges,
              CASE WHEN EXISTS(
                SELECT 1 FROM platform.model_option_role_binding AS required_role
                 WHERE required_role.revision_ref=option.revision_ref
              ) AND NOT EXISTS(
                SELECT 1 FROM platform.model_option_role_binding AS required_role
                 WHERE required_role.revision_ref=option.revision_ref
                   AND NOT EXISTS(
                     SELECT 1 FROM platform.model_definition_snapshot AS model
                     JOIN platform.model_definition_availability AS model_health
                       ON model_health.model_key=model.model_key AND model_health.status='active'
                     JOIN platform.model_provider_binding_snapshot AS provider_binding
                       ON provider_binding.import_id=model.import_id
                      AND provider_binding.model_key=model.model_key AND provider_binding.enabled
                     JOIN platform.model_provider_availability AS provider_health
                       ON provider_health.provider_key=provider_binding.provider_key
                      AND provider_health.status='active'
                      AND provider_health.health IN ('healthy','degraded')
                    WHERE model.import_id=publication.inventory_import_id
                      AND model.model_key=required_role.model_key AND model.enabled
                   )
              ) THEN 'available' ELSE 'temporarily_unavailable' END AS availability
         FROM platform.site_release_model_catalog_publication AS publication
         JOIN platform.site_release_model_catalog_surface AS surface
           ON surface.publication_id=publication.publication_id AND surface.surface_id='image'
         JOIN platform.site_release_model_catalog_option AS published
           ON published.publication_id=surface.publication_id AND published.surface_id=surface.surface_id
         JOIN platform.model_option_revision AS option
           ON option.revision_ref=published.revision_ref
          AND option.surface='image' AND option.lifecycle='active'
         JOIN platform.site_release_media_definition AS definition
           ON definition.site_ref=publication.site_id
          AND definition.site_release_ref=publication.site_release_ref
          AND definition.media_kind='image_text_to_image'
         JOIN platform.media_operation_definition_revision AS revision
           ON revision.definition_revision_ref=definition.definition_revision_ref
          AND revision.definition_key=$4
        WHERE publication.site_id=$1 AND publication.site_release_ref=$2
          AND publication.model_option_catalog_ref=$3
          AND ($5::integer IS NULL OR (published.position,published.revision_ref)>($5::integer,$6::text))
        ORDER BY published.position,published.revision_ref LIMIT $7`,
      [input.authority.siteRef, input.authority.siteReleaseRef, input.authority.modelOptionCatalogRef,
        input.definitionRef, input.positionAfter, input.modelOptionRevisionRefAfter, input.limit],
    );
    if (rows.length === 0) {
      const definition = await this.getDefinition(transaction, {
        authority: input.authority, definitionRef: input.definitionRef,
      });
      return definition === null ? null : Object.freeze({
        definitionRevisionRef: definition.definitionRevisionRef,
        options: Object.freeze([]),
      });
    }
    const options = rows.map((row) => parse(optionRowSchema, row, "MEDIA_PUBLIC_MODEL_OPTION_RECORD_CORRUPT"));
    const definitionRevisionRef = options[0]!.definitionRevisionRef;
    if (options.some((option) => option.definitionRevisionRef !== definitionRevisionRef)) {
      throw new Error("MEDIA_PUBLIC_MODEL_OPTION_RECORD_CORRUPT");
    }
    return Object.freeze({ definitionRevisionRef, options: Object.freeze(options) });
  }

  async listOperations(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    createdBefore: string | null;
    operationRefBefore: string | null;
    limit: number;
  }>): Promise<readonly MediaPublicOperationRecord[]> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `${OPERATION_SELECT}
       WHERE operation.site_ref=$1 AND operation.subject_ref=$2
         AND operation.subject_generation=$3::bigint AND operation.project_ref=$4
         AND ($5::timestamptz IS NULL OR
              (operation.created_at,operation.operation_ref)<($5::timestamptz,$6::text))
       ORDER BY operation.created_at DESC,operation.operation_ref DESC LIMIT $7`,
      ownerValues(input.authority, [input.createdBefore, input.operationRefBefore, input.limit]),
    );
    return Object.freeze(rows.map((row) => parse(operationRowSchema, row,
      "MEDIA_PUBLIC_OPERATION_RECORD_CORRUPT")));
  }

  async getOperation(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    operationRef: string;
  }>): Promise<MediaPublicOperationRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `${OPERATION_SELECT}
       WHERE operation.site_ref=$1 AND operation.subject_ref=$2
         AND operation.subject_generation=$3::bigint AND operation.project_ref=$4
         AND operation.operation_ref=$5 LIMIT 2`,
      ownerValues(input.authority, [input.operationRef]),
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("MEDIA_PUBLIC_OPERATION_RECORD_CORRUPT");
    return parse(operationRowSchema, rows[0], "MEDIA_PUBLIC_OPERATION_RECORD_CORRUPT");
  }
}

const DEFINITION_SELECT = `SELECT revision.definition_key AS "definitionKey",
       revision.definition_revision_ref AS "definitionRevisionRef",
       revision.media_kind AS "mediaKind",
       revision.maximum_candidate_count AS "maximumCandidateCount",
       revision.prompt_maximum_utf8_bytes AS "promptMaximumUtf8Bytes",
       revision.supported_aspect_ratios AS "supportedAspectRatios",
       revision.supported_output_formats AS "supportedOutputFormats",
       to_char(definition.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",
       surface.catalog_revision_ref AS "modelOptionCatalogRevisionRef"
  FROM platform.site_release_media_definition AS definition
  JOIN platform.media_operation_definition_revision AS revision
    ON revision.definition_revision_ref=definition.definition_revision_ref
  JOIN platform.site_release_model_catalog_publication AS publication
    ON publication.site_id=definition.site_ref
   AND publication.site_release_ref=definition.site_release_ref
  JOIN platform.site_release_model_catalog_surface AS surface
    ON surface.publication_id=publication.publication_id AND surface.surface_id='image'`;

const OPERATION_SELECT = `SELECT operation.operation_ref AS "operationRef",
       definition.definition_key AS "definitionKey",
       operation.definition_revision_ref AS "definitionRevisionRef",
       operation.model_option_revision_ref AS "modelOptionRevisionRef",operation.state,
       operation.outcome_class AS "outcomeClass",operation.owner_version::text AS "ownerVersion",
       operation.terminal_failure AS "terminalFailure",
       operation.financial_receipt_ref AS "financialReceiptRef",
       operation.actual_cost::text AS "actualCost",
       operation.terminal_credit_unit AS "terminalCreditUnit",
       to_char(operation.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
       to_char(operation.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'candidateRef',candidate.candidate_ref,'ordinal',candidate.ordinal,
         'ownerVersion',candidate.owner_version::text,'state',candidate.state,
         'artifactRef',candidate.artifact_ref,'artifactVersionRef',candidate.artifact_version_ref
       ) ORDER BY candidate.ordinal)
       FROM platform.media_candidate AS candidate
       WHERE candidate.operation_ref=operation.operation_ref
         AND candidate.site_ref=operation.site_ref AND candidate.subject_ref=operation.subject_ref
         AND candidate.subject_generation=operation.subject_generation
         AND candidate.project_ref=operation.project_ref),'[]'::jsonb) AS candidates
  FROM platform.media_operation AS operation
  JOIN platform.media_operation_definition_revision AS definition
    ON definition.definition_revision_ref=operation.definition_revision_ref`;

function ownerValues(authority: ResolvedMediaPublicOwnerAuthority,
  tail: readonly unknown[]): readonly unknown[] {
  return [authority.siteRef, authority.subjectRef, authority.subjectGeneration,
    authority.projectRef, ...tail];
}

function parse<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown, code: string): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function safeText(value: string): boolean {
  return value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
