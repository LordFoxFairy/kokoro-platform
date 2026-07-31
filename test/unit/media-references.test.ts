import { describe, expect, it } from "vitest";
import {
  mediaCandidateRef,
  mediaOperationRef,
  mediaStepRef,
  type MediaOperationRef,
} from "../../src/modules/media/domain/references.js";

describe("Media opaque references", () => {
  it("brands independently-owned identities without inventing a wire format", () => {
    const operationRef = mediaOperationRef("owner-issued/operation:01");
    const stepRef = mediaStepRef("owner-issued/step:01");
    const candidateRef = mediaCandidateRef("owner-issued/candidate:01");

    expect(operationRef).toBe("owner-issued/operation:01");
    expect(stepRef).toBe("owner-issued/step:01");
    expect(candidateRef).toBe("owner-issued/candidate:01");

    // @ts-expect-error Candidate identities must never be assignable as Operation identities.
    const _operationFromCandidate: MediaOperationRef = candidateRef;
    expect(_operationFromCandidate).toBe(candidateRef);
  });

  it("rejects empty, oversized, or control-character-bearing references", () => {
    expect(() => mediaOperationRef("")).toThrow("MEDIA_OPERATION_REF_INVALID");
    expect(() => mediaOperationRef("a".repeat(257))).toThrow("MEDIA_OPERATION_REF_INVALID");
    expect(() => mediaOperationRef("operation\n01")).toThrow("MEDIA_OPERATION_REF_INVALID");
    expect(() => mediaOperationRef("operation\t01")).toThrow("MEDIA_OPERATION_REF_INVALID");
    expect(() => mediaOperationRef("operation\u007f01")).toThrow("MEDIA_OPERATION_REF_INVALID");
  });

  it("accepts well-formed non-ASCII identities and rejects lone UTF-16 surrogates", () => {
    expect(mediaOperationRef("operation:图像:🎨")).toBe("operation:图像:🎨");
    expect(() => mediaOperationRef("operation:\ud800"))
      .toThrow("MEDIA_OPERATION_REF_INVALID");
    expect(() => mediaOperationRef("operation:\udc00"))
      .toThrow("MEDIA_OPERATION_REF_INVALID");
  });
});
