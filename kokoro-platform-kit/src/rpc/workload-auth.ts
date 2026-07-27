import { createHash, timingSafeEqual } from "node:crypto";
import {
  Code,
  ConnectError,
  createContextKey,
  type ContextValues,
  type Interceptor,
} from "@connectrpc/connect";

export const WORKLOAD_ID_HEADER = "x-kokoro-workload";
export const WORKLOAD_AUDIENCE_HEADER = "x-kokoro-audience";
export const WORKLOAD_ENVIRONMENT_HEADER = "x-kokoro-environment";
// Temporary pilot compatibility only. Replace with workload identity before GA.
export const WORKLOAD_SECRET_HEADER = "x-kokoro-proxy-secret";

export interface WorkloadContext {
  workload: string;
  audience: string;
  environment: string;
}

export interface WorkloadAuthOptions extends WorkloadContext {
  secrets: readonly string[];
}

export const workloadContextKey = createContextKey<WorkloadContext | undefined>(undefined, {
  description: "authenticated Kokoro workload identity",
});

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesRotationSecret(candidate: string, secrets: readonly string[]): boolean {
  const candidateDigest = digest(candidate);
  let matched = 0;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    matched |= timingSafeEqual(candidateDigest, digest(secret)) ? 1 : 0;
  }
  return matched === 1;
}

export function readWorkloadContext(values: ContextValues): WorkloadContext {
  const workload = values.get(workloadContextKey);
  if (workload === undefined) {
    throw new ConnectError("Workload context unavailable", Code.Internal);
  }
  return workload;
}

export function createWorkloadAuthInterceptor(options: WorkloadAuthOptions): Interceptor {
  return (next) => async (request) => {
    if (request.signal.aborted) {
      throw new ConnectError("Request deadline exceeded", Code.DeadlineExceeded);
    }

    const workload = request.header.get(WORKLOAD_ID_HEADER);
    const secret = request.header.get(WORKLOAD_SECRET_HEADER);
    if (
      workload === null ||
      workload !== options.workload ||
      secret === null ||
      !matchesRotationSecret(secret, options.secrets)
    ) {
      throw new ConnectError("Workload credential rejected", Code.Unauthenticated);
    }

    const audience = request.header.get(WORKLOAD_AUDIENCE_HEADER);
    const environment = request.header.get(WORKLOAD_ENVIRONMENT_HEADER);
    if (audience !== options.audience || environment !== options.environment) {
      throw new ConnectError("Workload scope rejected", Code.PermissionDenied);
    }

    request.contextValues.set(workloadContextKey, {
      workload: options.workload,
      audience: options.audience,
      environment: options.environment,
    });
    return next(request);
  };
}
