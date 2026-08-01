// Runtime shape authority generated from Root JSON Schema mirrors. Domain closure
// rules intentionally live outside this module.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import catalogSchema from "./product-surface-catalog.schema.json" with { type: "json" };
import profileSchema from "./launch-product-profile.schema.json" with { type: "json" };
import metadata from "./contract-metadata.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: false, strict: true, validateSchema: true });

export const PRODUCT_CATALOG_SCHEMA_ID =
  "https://contracts.kokoro.dev/product-surface-catalog/v1" as const;
export const LAUNCH_PROFILE_SCHEMA_ID =
  "https://contracts.kokoro.dev/launch-product-profile/v1" as const;

assertMirror(catalogSchema, PRODUCT_CATALOG_SCHEMA_ID);
assertMirror(profileSchema, LAUNCH_PROFILE_SCHEMA_ID);

const catalogValidator: ValidateFunction = ajv.compile(catalogSchema);
const profileValidator: ValidateFunction = ajv.compile(profileSchema);

export function validateProductCatalogShape(value: unknown): boolean {
  return catalogValidator(value);
}

export function validateLaunchProfileShape(value: unknown): boolean {
  return profileValidator(value);
}

function assertMirror(schema: Readonly<{ $id?: string }>, expectedId: string): void {
  const record = metadata.schemas.find((candidate) => candidate.schemaId === expectedId);
  if (schema.$id !== expectedId || record === undefined ||
      !/^[a-f0-9]{40,64}$/u.test(record.sourceCommit) ||
      !/^[a-f0-9]{64}$/u.test(record.sourceDigestSha256) ||
      !/^[a-f0-9]{64}$/u.test(record.artifactDigestSha256)) {
    throw new Error("PRODUCT_PUBLICATION_SCHEMA_MIRROR_INVALID");
  }
}
