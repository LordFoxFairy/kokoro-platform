import { Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  createRpcErrorInterceptor,
  RpcFailure,
  toConnectError,
  type RpcOutgoingDetails,
  type SafeRpcErrorDetail,
} from "../src/rpc/errors.js";

describe("RPC error mapping", () => {
  it.each([
    ["validation", Code.InvalidArgument],
    ["authentication", Code.Unauthenticated],
    ["permission", Code.PermissionDenied],
    ["not_found", Code.NotFound],
    ["conflict", Code.FailedPrecondition],
    ["unavailable", Code.Unavailable],
    ["deadline", Code.DeadlineExceeded],
  ] as const)("maps %s failures to canonical Connect codes", (kind, code) => {
    const error = toConnectError(new RpcFailure(kind, "admin.test", "Safe message"));
    expect(error.code).toBe(code);
    expect(error.rawMessage).toBe("Safe message");
  });

  it("attaches only caller-supplied generated safe details", () => {
    const createDetails = vi.fn((_detail: SafeRpcErrorDetail): RpcOutgoingDetails => []);
    const error = toConnectError(
      new RpcFailure("not_found", "operator.not_found", "Operator not found", {
        cause: new Error("admin@example.test test-current-secret"),
        retryClass: "never",
      }),
      { createDetails, requestId: "request-1", correlationId: "correlation-1" },
    );
    expect(createDetails).toHaveBeenCalledWith({
      domainCode: "operator.not_found",
      retryClass: "never",
      safeMessage: "Operator not found",
      requestId: "request-1",
      correlationId: "correlation-1",
      receiptRef: undefined,
    });
    expect(JSON.stringify(error)).not.toContain("admin@example.test");
    expect(JSON.stringify(error)).not.toContain("test-current-secret");
  });

  it("sanitizes unexpected database errors in the interceptor", async () => {
    const interceptor = createRpcErrorInterceptor();
    const next = vi.fn(async () => {
      throw new Error("Prisma failed for admin@example.test using test-current-secret");
    });
    const call = interceptor(next as never) as unknown as (req: {
      header: Headers;
    }) => Promise<unknown>;
    const promise = call({ header: new Headers() });
    await expect(promise).rejects.toMatchObject({ code: Code.Internal, rawMessage: "Internal owner error" });
    await promise.catch((error: unknown) => {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("test-current-secret");
    });
  });

  it("attaches a generated safe detail to an unexpected owner error when configured", () => {
    const createDetails = vi.fn((_detail: SafeRpcErrorDetail): RpcOutgoingDetails => []);
    const error = toConnectError(new Error("private database failure"), { createDetails });
    expect(error.code).toBe(Code.Internal);
    expect(createDetails).toHaveBeenCalledWith({
      domainCode: "rpc.internal",
      retryClass: "never",
      safeMessage: "Internal owner error",
      requestId: undefined,
      correlationId: undefined,
      receiptRef: undefined,
    });
  });
});
