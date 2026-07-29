import { AdmissionRetryClass } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AdmissionModelCatalogRepository } from "../../../model-control/application/contracts/product-model-option-ports.js";
import { PostgresProductModelOptionRepository } from "../../../model-control/infrastructure/postgres/product-model-option-repository.js";
import type {
  AdmissionModelOwnerPort,
  AdmissionOwnerResolution,
} from "../../application/platform-admission-owner-authority.js";

type ModelResolution = Awaited<ReturnType<AdmissionModelOwnerPort["resolve"]>>;

/** Resolves one immutable SiteRelease ModelOption into a healthy pre-effect runtime. */
export class PostgresAdmissionModelOwner implements AdmissionModelOwnerPort {
  constructor(
    private readonly repository: AdmissionModelCatalogRepository =
      new PostgresProductModelOptionRepository(),
  ) {}

  async resolve(
    transaction: PlatformTransaction,
    input: Parameters<AdmissionModelOwnerPort["resolve"]>[1],
  ): Promise<ModelResolution> {
    const snapshot = await this.repository.loadAdmissionModelSnapshot(transaction, {
      siteId: input.siteId,
      siteReleaseRef: input.configurationRevisionId,
      modelOptionRevisionRef: input.modelOptionRevisionRef,
    });
    if (snapshot === null) return denied("ADMISSION_MODEL_OPTION_NOT_AVAILABLE");
    const option = snapshot.optionRevision;
    if (
      snapshot.siteId !== input.siteId ||
      snapshot.siteReleaseRef !== input.configurationRevisionId ||
      option.modelOptionRevisionRef !== input.modelOptionRevisionRef ||
      option.inventoryDigest !== snapshot.inventoryDigest
    ) throw new Error("ADMISSION_MODEL_OWNER_CORRUPT");
    if (option.lifecycle !== "active") return denied("ADMISSION_MODEL_OPTION_NOT_AVAILABLE");
    if (
      input.requestedEffort !== undefined &&
      !option.supportedEfforts.includes(input.requestedEffort)
    ) return denied("ADMISSION_MODEL_EFFORT_NOT_SUPPORTED");

    const declaredModels = [
      option.composition.orchestration.primaryModelKey,
      ...option.composition.orchestration.fallbackModelKeys,
    ];
    const candidates = snapshot.runtimeCandidates.map((candidate) => {
      const declaredPosition = declaredModels.indexOf(candidate.modelKey);
      if (declaredPosition < 0 || candidate.modelPosition !== declaredPosition) {
        throw new Error("ADMISSION_MODEL_OWNER_CORRUPT");
      }
      return candidate;
    }).sort((left, right) =>
      left.modelPosition - right.modelPosition ||
      left.bindingPriority - right.bindingPriority ||
      left.providerPriority - right.providerPriority ||
      compare(left.bindingKey, right.bindingKey));
    const selected = candidates[0];
    if (selected === undefined) return denied("ADMISSION_MODEL_RUNTIME_UNAVAILABLE");
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({
        provider: selected.adapterKind === "litellm" ? "litellm" : selected.provider,
        name: selected.adapterKind === "litellm"
          ? selected.gatewayModelName
          : selected.upstreamModel,
        ...(input.requestedEffort === undefined ? {} : { effort: input.requestedEffort }),
        modelLabel: option.label,
      }),
    });
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function denied(code: string): AdmissionOwnerResolution<never> {
  return Object.freeze({
    kind: "denied",
    denial: Object.freeze({ code, retryClass: AdmissionRetryClass.NEVER }),
  });
}
