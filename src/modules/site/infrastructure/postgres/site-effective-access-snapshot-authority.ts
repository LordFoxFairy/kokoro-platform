import { z } from "zod";
import type {
  SiteEffectiveAccessSnapshot,
  SiteEffectiveAccessSnapshotPort,
} from "../../application/contracts/site-effective-access-snapshot.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import {
  deepFreeze,
  digestReferenceSchema,
  exactlyOne,
  revisionBinding,
  wireRevisionBindingSchema,
} from "./site-publication-authority-codecs.js";

const uniqueBindings = <Schema extends z.ZodType>(schema: Schema) => z.array(schema).min(1).max(128)
  .refine((values) => new Set(values.map((value) =>
    (value as { ref: string }).ref)).size === values.length);

export const siteEffectiveAccessSnapshotWireSchema = z.object({
  webBuildMaterialBundle: wireRevisionBindingSchema,
  siteConfig: wireRevisionBindingSchema,
  legalPolicy: wireRevisionBindingSchema,
  salesPolicy: wireRevisionBindingSchema,
  assortmentPolicy: wireRevisionBindingSchema,
  memoryPolicy: wireRevisionBindingSchema,
  authIdentityClosure: z.object({
    identityIssuer: wireRevisionBindingSchema,
    authenticationPolicy: wireRevisionBindingSchema,
    authorizationPolicy: wireRevisionBindingSchema,
    closureDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }).strict(),
  commerceClosure: z.object({
    offerRevisions: uniqueBindings(wireRevisionBindingSchema),
    offerPriceRevisions: uniqueBindings(wireRevisionBindingSchema),
    entitlementTemplateRevisions: uniqueBindings(wireRevisionBindingSchema),
    creditProgramRevisions: uniqueBindings(wireRevisionBindingSchema),
    closureDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }).strict(),
  hubClosure: z.object({
    capabilityAssignment: wireRevisionBindingSchema,
    capabilityCatalog: wireRevisionBindingSchema,
    agentCatalog: wireRevisionBindingSchema,
    closureDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }).strict(),
  modelRequirements: z.array(z.object({
    modelRoleRef: z.string().min(3).max(256),
    modelInventory: digestReferenceSchema,
    modelCatalog: digestReferenceSchema,
  }).strict()).max(64).refine((values) =>
    new Set(values.map(({ modelRoleRef }) => modelRoleRef)).size === values.length),
}).strict();

interface EffectiveAccessRow extends Record<string, unknown> { readonly snapshot: unknown }

export class PostgresSiteEffectiveAccessSnapshotAuthority
implements SiteEffectiveAccessSnapshotPort {
  async resolve(
    transaction: Parameters<SiteEffectiveAccessSnapshotPort["resolve"]>[0],
    input: Parameters<SiteEffectiveAccessSnapshotPort["resolve"]>[1],
  ): Promise<SiteEffectiveAccessSnapshot> {
    const rows = await resolvePlatformTransaction(transaction).query<EffectiveAccessRow>(
      `SELECT authority.snapshot
       FROM platform.site_effective_access_authority_revision authority
       JOIN platform.launch_product_profile_revision profile
         ON profile.profile_revision_ref=authority.profile_ref
        AND profile.revision=authority.profile_revision AND profile.digest=authority.profile_digest
       JOIN platform.product_surface_catalog_revision catalog
         ON catalog.catalog_revision_ref=authority.catalog_ref
        AND catalog.revision=authority.catalog_revision AND catalog.digest=authority.catalog_digest
        AND profile.catalog_revision_ref=catalog.catalog_revision_ref
        AND profile.catalog_revision=catalog.revision AND profile.catalog_digest=catalog.digest
       WHERE authority.site_ref=$1 AND authority.environment=$2
         AND authority.profile_ref=$3 AND authority.profile_revision=$4::numeric(20,0)
         AND authority.profile_digest=$5 AND authority.catalog_ref=$6
         AND authority.catalog_revision=$7::numeric(20,0) AND authority.catalog_digest=$8`,
      [input.siteRef, input.environment, input.launchProductProfile.ref,
        input.launchProductProfile.revision.toString(), input.launchProductProfile.digest,
        input.productSurfaceCatalog.ref, input.productSurfaceCatalog.revision.toString(),
        input.productSurfaceCatalog.digest],
    );
    const row = exactlyOne(rows, "SITE_EFFECTIVE_ACCESS_AUTHORITY_NOT_FOUND");
    const parsed = siteEffectiveAccessSnapshotWireSchema.safeParse(row.snapshot);
    if (!parsed.success) throw new Error("SITE_EFFECTIVE_ACCESS_AUTHORITY_CORRUPT");
    const value = parsed.data;
    return deepFreeze({
      webBuildMaterialBundle: revisionBinding(value.webBuildMaterialBundle),
      siteConfig: revisionBinding(value.siteConfig),
      legalPolicy: revisionBinding(value.legalPolicy),
      salesPolicy: revisionBinding(value.salesPolicy),
      assortmentPolicy: revisionBinding(value.assortmentPolicy),
      memoryPolicy: revisionBinding(value.memoryPolicy),
      authIdentityClosure: {
        identityIssuer: revisionBinding(value.authIdentityClosure.identityIssuer),
        authenticationPolicy: revisionBinding(value.authIdentityClosure.authenticationPolicy),
        authorizationPolicy: revisionBinding(value.authIdentityClosure.authorizationPolicy),
        closureDigest: value.authIdentityClosure.closureDigest,
      },
      commerceClosure: {
        offerRevisions: value.commerceClosure.offerRevisions.map(revisionBinding),
        offerPriceRevisions: value.commerceClosure.offerPriceRevisions.map(revisionBinding),
        entitlementTemplateRevisions:
          value.commerceClosure.entitlementTemplateRevisions.map(revisionBinding),
        creditProgramRevisions: value.commerceClosure.creditProgramRevisions.map(revisionBinding),
        closureDigest: value.commerceClosure.closureDigest,
      },
      hubClosure: {
        capabilityAssignment: revisionBinding(value.hubClosure.capabilityAssignment),
        capabilityCatalog: revisionBinding(value.hubClosure.capabilityCatalog),
        agentCatalog: revisionBinding(value.hubClosure.agentCatalog),
        closureDigest: value.hubClosure.closureDigest,
      },
      modelRequirements: value.modelRequirements.map((requirement) => Object.freeze({
        modelRoleRef: requirement.modelRoleRef,
        modelInventory: Object.freeze(requirement.modelInventory),
        modelCatalog: Object.freeze(requirement.modelCatalog),
      })),
    });
  }
}
