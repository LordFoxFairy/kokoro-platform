import { describe, expect, it } from "vitest";
import { parseLegacySecretReference } from "../../src/modules/model-control/migration/legacy-secret-reference.js";

describe("legacy ModelControl provider secret references", () => {
  it.each(["secret://provider/a", "vault://model/prod", "env://MODEL_PROVIDER_KEY"])(
    "preserves an already indirect reference: %s",
    (reference) => {
      expect(parseLegacySecretReference(reference)).toBe(reference);
    },
  );

  it.each(["sk-plaintext", "MODEL_PROVIDER_KEY", "env://", " secret://provider/a"])(
    "quarantines a non-reference without echoing it: %s",
    (candidate) => {
      expect(() => parseLegacySecretReference(candidate)).toThrowError(
        "LEGACY_PROVIDER_SECRET_REFERENCE_INVALID",
      );
      try {
        parseLegacySecretReference(candidate);
      } catch (error) {
        expect(String(error)).not.toContain(candidate);
      }
    },
  );
});
