import { Code, ConnectError, createContextValues } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkloadAuthInterceptor,
  readWorkloadContext,
  WORKLOAD_AUDIENCE_HEADER,
  WORKLOAD_ENVIRONMENT_HEADER,
  WORKLOAD_ID_HEADER,
  WORKLOAD_SECRET_HEADER,
} from "../src/rpc/workload-auth.js";

const currentSecret = "test-current-secret";
const previousSecret = "test-previous-secret";

function request(headers: HeadersInit, signal = new AbortController().signal) {
  return {
    stream: false,
    service: {} as never,
    method: {} as never,
    requestMethod: "POST",
    url: "http://platform.test/kokoro.platform.admin.v1.AdminAuthService/GetOperator",
    signal,
    header: new Headers(headers),
    contextValues: createContextValues(),
    message: {},
  } as const;
}

function validHeaders(secret = currentSecret): HeadersInit {
  return {
    [WORKLOAD_ID_HEADER]: "admin-web",
    [WORKLOAD_AUDIENCE_HEADER]: "admin-web",
    [WORKLOAD_ENVIRONMENT_HEADER]: "test",
    [WORKLOAD_SECRET_HEADER]: secret,
  };
}

async function invoke(headers: HeadersInit, signal?: AbortSignal) {
  const next = vi.fn(async (req: ReturnType<typeof request>) => {
    const workload = readWorkloadContext(req.contextValues);
    return { workload };
  });
  const interceptor = createWorkloadAuthInterceptor({
    workload: "admin-web",
    audience: "admin-web",
    environment: "test",
    secrets: [currentSecret, previousSecret],
  });
  const call = interceptor(next as never) as unknown as (
    req: ReturnType<typeof request>,
  ) => Promise<{ workload: ReturnType<typeof readWorkloadContext> }>;
  return { result: await call(request(headers, signal)), next };
}

async function expectCode(promise: Promise<unknown>, code: Code): Promise<ConnectError> {
  try {
    await promise;
    throw new Error("expected ConnectError");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(code);
    return error as ConnectError;
  }
}

describe("workload auth interceptor", () => {
  it("rejects a missing caller without invoking the handler", async () => {
    const headers = validHeaders();
    delete (headers as Record<string, string>)[WORKLOAD_ID_HEADER];
    const interceptor = createWorkloadAuthInterceptor({
      workload: "admin-web",
      audience: "admin-web",
      environment: "test",
      secrets: [currentSecret],
    });
    const next = vi.fn();
    const call = interceptor(next as never) as unknown as (req: ReturnType<typeof request>) => Promise<unknown>;
    await expectCode(call(request(headers)), Code.Unauthenticated);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects the wrong audience and environment", async () => {
    await expectCode(invoke({ ...validHeaders(), [WORKLOAD_AUDIENCE_HEADER]: "other" }), Code.PermissionDenied);
    await expectCode(invoke({ ...validHeaders(), [WORKLOAD_ENVIRONMENT_HEADER]: "production" }), Code.PermissionDenied);
  });

  it("rejects the wrong temporary rotation secret", async () => {
    const error = await expectCode(invoke(validHeaders("wrong-secret")), Code.Unauthenticated);
    expect(error.rawMessage).not.toContain("wrong-secret");
    expect(error.rawMessage).not.toContain(currentSecret);
  });

  it.each([currentSecret, previousSecret])("accepts a current or previous rotation secret", async (secret) => {
    const { result, next } = await invoke(validHeaders(secret));
    expect(result.workload).toEqual({ workload: "admin-web", audience: "admin-web", environment: "test" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects an already expired deadline", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await expectCode(invoke(validHeaders(), controller.signal), Code.DeadlineExceeded);
  });
});
