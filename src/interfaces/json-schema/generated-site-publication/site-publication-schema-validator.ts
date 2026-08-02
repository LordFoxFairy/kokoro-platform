import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import candidateSchema from "./site-release-candidate.schema.json" with { type: "json" };
import inventorySchema from "./surface-inventory.schema.json" with { type: "json" };
import materialSchema from "./web-build-material-bundle.schema.json" with { type: "json" };
import intentSchema from "./web-build-intent.schema.json" with { type: "json" };
import manifestSchema from "./compiled-web-manifest.schema.json" with { type: "json" };
import provenanceSchema from "./web-artifact-provenance-profile.schema.json" with { type: "json" };
import certificationSchema from "./release-certification-instance.schema.json" with { type: "json" };
import releaseSchema from "./site-release.schema.json" with { type: "json" };

const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });

export const validateSiteReleaseCandidateShape = compile(candidateSchema);
export const validateSurfaceInventoryShape = compile(inventorySchema);
export const validateWebBuildMaterialBundleShape = compile(materialSchema);
export const validateWebBuildIntentShape = compile(intentSchema);
export const validateCompiledWebManifestShape = compile(manifestSchema);
export const validateWebArtifactProvenanceShape = compile(provenanceSchema);
export const validateReleaseCertificationShape = compile(certificationSchema);
export const validateSiteReleaseShape = compile(releaseSchema);

function compile(schema: object): ValidateFunction<unknown> {
  return ajv.compile(schema);
}
