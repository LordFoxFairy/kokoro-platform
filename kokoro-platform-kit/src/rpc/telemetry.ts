import { performance } from "node:perf_hooks";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { Counter, Histogram, register, type Registry } from "prom-client";
import type { WorkloadContext } from "./workload-auth.js";
import {
  WORKLOAD_AUDIENCE_HEADER,
  WORKLOAD_ENVIRONMENT_HEADER,
  WORKLOAD_ID_HEADER,
  workloadContextKey,
} from "./workload-auth.js";

export type RpcCodeName =
  | "ok"
  | "canceled"
  | "unknown"
  | "invalid_argument"
  | "deadline_exceeded"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "failed_precondition"
  | "aborted"
  | "out_of_range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data_loss"
  | "unauthenticated";

export interface RpcMetricLabels {
  service: string;
  method: string;
  code: RpcCodeName;
  workload: string;
}

export interface RpcMetrics {
  recordRequest(labels: RpcMetricLabels): void;
  observeDuration(labels: RpcMetricLabels, seconds: number): void;
}

export type RpcSecurityAuditEvent = "workload_auth_failure" | "validation_failure" | "rpc_outcome";

export interface RpcSecurityAuditRecord extends RpcMetricLabels {
  event: RpcSecurityAuditEvent;
  audience: string;
  environment: string;
}

export interface RpcSecurityAuditSink {
  record(record: RpcSecurityAuditRecord): void | Promise<void>;
}

export interface RpcTelemetryOptions {
  identity: WorkloadContext;
  metrics: RpcMetrics;
  audit: RpcSecurityAuditSink;
  now?: () => number;
}

const codeNames: Readonly<Record<Code, RpcCodeName>> = {
  [Code.Canceled]: "canceled",
  [Code.Unknown]: "unknown",
  [Code.InvalidArgument]: "invalid_argument",
  [Code.DeadlineExceeded]: "deadline_exceeded",
  [Code.NotFound]: "not_found",
  [Code.AlreadyExists]: "already_exists",
  [Code.PermissionDenied]: "permission_denied",
  [Code.ResourceExhausted]: "resource_exhausted",
  [Code.FailedPrecondition]: "failed_precondition",
  [Code.Aborted]: "aborted",
  [Code.OutOfRange]: "out_of_range",
  [Code.Unimplemented]: "unimplemented",
  [Code.Internal]: "internal",
  [Code.Unavailable]: "unavailable",
  [Code.DataLoss]: "data_loss",
  [Code.Unauthenticated]: "unauthenticated",
};

const metricLabelNames = ["service", "method", "code", "workload"] as const;
type RpcMetricLabelName = (typeof metricLabelNames)[number];

export function createPrometheusRpcMetrics(registry: Registry = register): RpcMetrics {
  const registeredRequests = registry.getSingleMetric<RpcMetricLabelName>(
    "kokoro_rpc_requests_total",
  );
  if (registeredRequests !== undefined && !(registeredRequests instanceof Counter)) {
    throw new Error(
      "kokoro_rpc_requests_total is already registered with an incompatible metric type",
    );
  }
  const requests =
    registeredRequests ??
    new Counter<RpcMetricLabelName>({
      name: "kokoro_rpc_requests_total",
      help: "Completed Kokoro Connect RPC requests by safe bounded outcome labels",
      labelNames: metricLabelNames,
      registers: [registry],
    });

  const registeredDuration = registry.getSingleMetric<RpcMetricLabelName>(
    "kokoro_rpc_duration_seconds",
  );
  if (registeredDuration !== undefined && !(registeredDuration instanceof Histogram)) {
    throw new Error(
      "kokoro_rpc_duration_seconds is already registered with an incompatible metric type",
    );
  }
  const duration =
    registeredDuration ??
    new Histogram<RpcMetricLabelName>({
      name: "kokoro_rpc_duration_seconds",
      help: "Kokoro Connect RPC duration in seconds by safe bounded outcome labels",
      labelNames: metricLabelNames,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });

  return {
    recordRequest: (labels) => requests.inc(labels),
    observeDuration: (labels, seconds) => duration.observe(labels, seconds),
  };
}

function allowlisted(value: string | null, expected: string): string {
  return value === expected ? expected : "unknown";
}

function recordAudit(sink: RpcSecurityAuditSink, record: RpcSecurityAuditRecord): void {
  try {
    void Promise.resolve(sink.record(record)).catch(() => undefined);
  } catch {
    // Audit is a fail-open side channel and must never change RPC behavior.
  }
}

function recordMetrics(metrics: RpcMetrics, labels: RpcMetricLabels, seconds: number): void {
  try {
    metrics.recordRequest(labels);
  } catch {
    // Metrics are a fail-open side channel and must never change RPC behavior.
  }
  try {
    metrics.observeDuration(labels, seconds);
  } catch {
    // Metrics are a fail-open side channel and must never change RPC behavior.
  }
}

function outcomeCode(error: unknown): RpcCodeName {
  return error instanceof ConnectError ? codeNames[error.code] : "internal";
}

function readClock(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createRpcTelemetryInterceptor(options: RpcTelemetryOptions): Interceptor {
  const now = options.now ?? (() => performance.now());
  return (next) => async (request) => {
    const startedAt = readClock(now);

    const emit = (code: RpcCodeName): void => {
      const workload = allowlisted(
        request.header.get(WORKLOAD_ID_HEADER),
        options.identity.workload,
      );
      const labels: RpcMetricLabels = {
        service: request.service.typeName,
        method: request.method.name,
        code,
        workload,
      };
      const endedAt = readClock(now);
      const durationSeconds =
        startedAt === undefined || endedAt === undefined
          ? 0
          : Math.max(0, endedAt - startedAt) / 1_000;
      recordMetrics(options.metrics, labels, durationSeconds);

      const auditBase = {
        ...labels,
        audience: allowlisted(
          request.header.get(WORKLOAD_AUDIENCE_HEADER),
          options.identity.audience,
        ),
        environment: allowlisted(
          request.header.get(WORKLOAD_ENVIRONMENT_HEADER),
          options.identity.environment,
        ),
      };
      const workloadAuthenticated = request.contextValues.get(workloadContextKey) !== undefined;
      if (!workloadAuthenticated && (code === "unauthenticated" || code === "permission_denied")) {
        recordAudit(options.audit, { ...auditBase, event: "workload_auth_failure" });
      } else if (code === "invalid_argument") {
        recordAudit(options.audit, { ...auditBase, event: "validation_failure" });
      }
      recordAudit(options.audit, { ...auditBase, event: "rpc_outcome" });
    };

    const emitFailOpen = (code: RpcCodeName): void => {
      try {
        emit(code);
      } catch {
        // No telemetry implementation failure may replace an RPC result.
      }
    };

    try {
      const result = await next(request);
      emitFailOpen("ok");
      return result;
    } catch (error) {
      emitFailOpen(outcomeCode(error));
      throw error;
    }
  };
}
