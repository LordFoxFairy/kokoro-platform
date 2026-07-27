import { Code, ConnectError, createContextValues } from "@connectrpc/connect";
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import {
  createPrometheusRpcMetrics,
  createRpcTelemetryInterceptor,
  type RpcMetricLabels,
  type RpcSecurityAuditRecord,
} from "../src/rpc/telemetry.js";
import {
  WORKLOAD_AUDIENCE_HEADER,
  WORKLOAD_ENVIRONMENT_HEADER,
  WORKLOAD_ID_HEADER,
  WORKLOAD_SECRET_HEADER,
  workloadContextKey,
} from "../src/rpc/workload-auth.js";

const identity = {
  workload: "admin-web",
  audience: "admin-web",
  environment: "test",
};

function request(headers: HeadersInit = {}) {
  return {
    stream: false,
    service: { typeName: "kokoro.platform.admin.v1.AdminAuthService" } as never,
    method: { name: "GetOperator" } as never,
    requestMethod: "POST",
    url: "http://platform.test/kokoro.platform.admin.v1.AdminAuthService/GetOperator",
    signal: new AbortController().signal,
    header: new Headers(headers),
    contextValues: createContextValues(),
    message: {},
  } as const;
}

function validHeaders(): HeadersInit {
  return {
    [WORKLOAD_ID_HEADER]: identity.workload,
    [WORKLOAD_AUDIENCE_HEADER]: identity.audience,
    [WORKLOAD_ENVIRONMENT_HEADER]: identity.environment,
    [WORKLOAD_SECRET_HEADER]: "test-current-secret",
  };
}

function telemetry() {
  const requests: RpcMetricLabels[] = [];
  const durations: Array<{ labels: RpcMetricLabels; seconds: number }> = [];
  const audit: RpcSecurityAuditRecord[] = [];
  const interceptor = createRpcTelemetryInterceptor({
    identity,
    metrics: {
      recordRequest: (labels) => {
        requests.push(labels);
      },
      observeDuration: (labels, seconds) => {
        durations.push({ labels, seconds });
      },
    },
    audit: {
      record: (record) => {
        audit.push(record);
      },
    },
    now: vi.fn().mockReturnValueOnce(10_000).mockReturnValueOnce(10_250),
  });
  return { interceptor, requests, durations, audit };
}

async function invoke(
  interceptor: ReturnType<typeof createRpcTelemetryInterceptor>,
  next: (req: ReturnType<typeof request>) => Promise<unknown>,
  headers: HeadersInit = validHeaders(),
): Promise<unknown> {
  const call = interceptor(next as never) as unknown as (
    req: ReturnType<typeof request>,
  ) => Promise<unknown>;
  return call(request(headers));
}

describe("RPC telemetry interceptor", () => {
  it("publishes bounded RPC request and duration metrics", async () => {
    const registry = new Registry();
    const metrics = createPrometheusRpcMetrics(registry);
    const labels: RpcMetricLabels = {
      service: "kokoro.platform.admin.v1.AdminAuthService",
      method: "GetOperator",
      code: "ok",
      workload: "admin-web",
    };

    metrics.recordRequest(labels);
    metrics.observeDuration(labels, 0.25);

    const output = await registry.metrics();
    expect(output).toContain("kokoro_rpc_requests_total");
    expect(output).toContain("kokoro_rpc_duration_seconds");
    expect(output).toContain('code="ok"');
    expect(output).toContain('workload="admin-web"');
  });

  it("records one safe success outcome and duration", async () => {
    const observed = telemetry();

    await expect(invoke(observed.interceptor, async () => ({ ok: true }))).resolves.toEqual({
      ok: true,
    });

    const labels = {
      service: "kokoro.platform.admin.v1.AdminAuthService",
      method: "GetOperator",
      code: "ok",
      workload: "admin-web",
    };
    expect(observed.requests).toEqual([labels]);
    expect(observed.durations).toEqual([{ labels, seconds: 0.25 }]);
    expect(observed.audit).toEqual([
      {
        event: "rpc_outcome",
        service: labels.service,
        method: labels.method,
        code: "ok",
        workload: "admin-web",
        audience: "admin-web",
        environment: "test",
      },
    ]);
  });

  it.each([
    [Code.Unauthenticated, "unauthenticated"],
    [Code.PermissionDenied, "permission_denied"],
  ] as const)("records a workload auth failure for canonical code %s", async (code, codeName) => {
    const observed = telemetry();

    await expect(
      invoke(observed.interceptor, async () => {
        throw new ConnectError("safe", code);
      }),
    ).rejects.toMatchObject({ code });

    expect(observed.audit.map((record) => record.event)).toEqual([
      "workload_auth_failure",
      "rpc_outcome",
    ]);
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]?.code).toBe(codeName);
  });

  it("does not classify an authenticated handler permission failure as workload auth", async () => {
    const observed = telemetry();

    await expect(
      invoke(observed.interceptor, async (req) => {
        req.contextValues.set(workloadContextKey, identity);
        throw new ConnectError("safe", Code.PermissionDenied);
      }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });

    expect(observed.audit.map((record) => record.event)).toEqual(["rpc_outcome"]);
  });

  it("records a validation failure and outcome for invalid arguments", async () => {
    const observed = telemetry();

    await expect(
      invoke(observed.interceptor, async () => {
        throw new ConnectError("safe", Code.InvalidArgument);
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });

    expect(observed.audit.map((record) => record.event)).toEqual([
      "validation_failure",
      "rpc_outcome",
    ]);
    expect(observed.requests).toMatchObject([{ code: "invalid_argument" }]);
  });

  it("uses the canonical canceled outcome name", async () => {
    const observed = telemetry();

    await expect(
      invoke(observed.interceptor, async () => {
        throw new ConnectError("safe", Code.Canceled);
      }),
    ).rejects.toMatchObject({ code: Code.Canceled });

    expect(observed.requests[0]?.code).toBe("canceled");
  });

  it("maps unrecognized caller metadata to unknown without recording sensitive values", async () => {
    const observed = telemetry();
    const sensitive = {
      email: "operator@example.test",
      token: "raw-verification-token",
      commandId: "command-high-cardinality-1",
      digest: "a".repeat(64),
      secret: "test-current-secret",
    };

    await invoke(observed.interceptor, async () => ({ ok: true }), {
      [WORKLOAD_ID_HEADER]: sensitive.commandId,
      [WORKLOAD_AUDIENCE_HEADER]: sensitive.email,
      [WORKLOAD_ENVIRONMENT_HEADER]: sensitive.digest,
      [WORKLOAD_SECRET_HEADER]: sensitive.secret,
    });

    expect(observed.requests[0]?.workload).toBe("unknown");
    expect(observed.audit[0]).toMatchObject({
      workload: "unknown",
      audience: "unknown",
      environment: "unknown",
    });
    const serialized = JSON.stringify({ requests: observed.requests, audit: observed.audit });
    for (const value of Object.values(sensitive)) expect(serialized).not.toContain(value);
  });

  it("keeps successful RPCs successful when every telemetry sink throws", async () => {
    const interceptor = createRpcTelemetryInterceptor({
      identity,
      metrics: {
        recordRequest: () => {
          throw new Error("metrics unavailable");
        },
        observeDuration: () => {
          throw new Error("metrics unavailable");
        },
      },
      audit: {
        record: async () => {
          throw new Error("audit unavailable");
        },
      },
    });

    await expect(invoke(interceptor, async () => "handler-result")).resolves.toBe("handler-result");
  });

  it("does not wait for an unresolved async audit sink", async () => {
    const interceptor = createRpcTelemetryInterceptor({
      identity,
      metrics: {
        recordRequest: () => undefined,
        observeDuration: () => undefined,
      },
      audit: { record: () => new Promise<void>(() => undefined) },
    });

    const settled = await Promise.race([
      invoke(interceptor, async () => "handler-result"),
      new Promise<string>((resolve) => setTimeout(() => resolve("audit-timeout"), 25)),
    ]);

    expect(settled).toBe("handler-result");
  });

  it("keeps RPCs successful when the telemetry clock throws", async () => {
    const interceptor = createRpcTelemetryInterceptor({
      identity,
      metrics: {
        recordRequest: () => undefined,
        observeDuration: () => undefined,
      },
      audit: { record: () => undefined },
      now: () => {
        throw new Error("clock unavailable");
      },
    });

    await expect(invoke(interceptor, async () => "handler-result")).resolves.toBe("handler-result");
  });

  it("preserves RPC failures when every telemetry sink throws", async () => {
    const original = new ConnectError("original safe failure", Code.NotFound);
    const interceptor = createRpcTelemetryInterceptor({
      identity,
      metrics: {
        recordRequest: () => {
          throw new Error("metrics unavailable");
        },
        observeDuration: () => {
          throw new Error("metrics unavailable");
        },
      },
      audit: {
        record: async () => {
          throw new Error("audit unavailable");
        },
      },
    });

    await expect(
      invoke(interceptor, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
