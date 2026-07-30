import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  capabilitySignaturePayloadDigest,
  capabilitySnapshotDigest,
  createEd25519CapabilityPublicationVerifier,
  type CapabilityCatalogPublication,
} from "../../src/modules/admission/infrastructure/crypto/capability-publication-verifier.js";

const snapshot = Object.freeze({
  schemaVersion: 1 as const,
  agentOptions: Object.freeze([{ optionRef: "agent-default", agent: "general", label: "General" }]),
  defaultAgentOptionRef: "agent-default",
  tools: Object.freeze(["search", "write"]),
  skillOptions: Object.freeze([{
    optionRef: "skill-writer", label: "Writer", name: "writer",
    contentHash: "a".repeat(64), description: "Writes a document", scope: "global",
  }]),
  mcpOptions: Object.freeze([{
    optionRef: "mcp-github", label: "GitHub", scope: "tenant-a", name: "github",
    revision: 1, configHash: "b".repeat(64),
  }]),
  subagents: Object.freeze(["researcher"]),
});

describe("capability publication verifier", () => {
  it("binds the exact canonical snapshot, SiteRelease, catalog ref, digest, and signing key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const snapshotDigest = capabilitySnapshotDigest(snapshot);
    const publicationBase = {
      siteId: "site-a",
      siteReleaseRef: "release-a",
      agentCatalogRef: `agent-catalog:sha256:${snapshotDigest}`,
      snapshotDigest,
      snapshot,
      frozenAt: "2026-07-29T12:00:00.000Z",
      signingKeyRef: "hub-signing-2026-07",
      signatureAlgorithm: "ed25519-sha256-v1" as const,
    };
    const signaturePayloadDigest = capabilitySignaturePayloadDigest(publicationBase);
    const publication: CapabilityCatalogPublication = Object.freeze({
      ...publicationBase,
      signaturePayloadDigest,
      signature: sign(null, Buffer.from(signaturePayloadDigest, "hex"), privateKey),
    });
    const verify = createEd25519CapabilityPublicationVerifier({
      keys: new Map([[publication.signingKeyRef, publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    });

    expect(verify(publication)).toEqual(publication);
    expect(() => verify({ ...publication, siteReleaseRef: "release-b" })).toThrow(
      "CAPABILITY_PUBLICATION_SIGNATURE_PAYLOAD_MISMATCH",
    );
    expect(() => verify({ ...publication, snapshot: { ...snapshot, tools: ["write"] } })).toThrow(
      "CAPABILITY_PUBLICATION_SNAPSHOT_DIGEST_MISMATCH",
    );
    expect(() => verify({ ...publication, signingKeyRef: "hub-signing-unknown" })).toThrow(
      "CAPABILITY_PUBLICATION_SIGNING_KEY_UNKNOWN",
    );
  });

  it("rejects non-canonical or duplicate option ordering", () => {
    expect(() => capabilitySnapshotDigest({
      ...snapshot,
      tools: ["write", "search"],
    })).toThrow("CAPABILITY_PUBLICATION_SNAPSHOT_NOT_CANONICAL");
    expect(() => capabilitySnapshotDigest({
      ...snapshot,
      skillOptions: [snapshot.skillOptions[0]!, snapshot.skillOptions[0]!],
    })).toThrow("CAPABILITY_PUBLICATION_SNAPSHOT_NOT_CANONICAL");
  });
});
