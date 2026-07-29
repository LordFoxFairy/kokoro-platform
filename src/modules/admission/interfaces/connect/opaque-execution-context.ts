import { executionContextIntentSchema, type ExecutionContextIntent } from "@kokoro/platform-kit";
import type { OpaqueExecutionContextIntent } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";

/**
 * Maps Admission's transport oneof into the GA-owned opaque intent.
 * Platform validates the reference syntax but never resolves Agent state.
 */
export function mapOpaqueExecutionContextIntent(
  wire: OpaqueExecutionContextIntent,
): ExecutionContextIntent {
  try {
    switch (wire.mode.case) {
      case "root":
        if (wire.mode.value !== true) throw new Error("root must be true");
        return executionContextIntentSchema.parse({ mode: "root" });
      case "continueFrom":
        return executionContextIntentSchema.parse({
          mode: "continue",
          parent_anchor: wire.mode.value.anchor,
          parent_digest: wire.mode.value.digest,
        });
      case "forkFrom":
        return executionContextIntentSchema.parse({
          mode: "fork",
          parent_anchor: wire.mode.value.anchor,
          parent_digest: wire.mode.value.digest,
        });
      default:
        throw new Error("mode is required");
    }
  } catch (cause) {
    throw new Error("ADMISSION_EXECUTION_CONTEXT_INVALID", { cause });
  }
}
