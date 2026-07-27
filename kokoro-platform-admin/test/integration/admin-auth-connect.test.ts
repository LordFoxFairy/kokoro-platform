import { create } from "@bufbuild/protobuf";
import { createClient, Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  WORKLOAD_AUDIENCE_HEADER,
  WORKLOAD_ENVIRONMENT_HEADER,
  WORKLOAD_ID_HEADER,
  WORKLOAD_SECRET_HEADER,
  type RpcMetricLabels,
  type RpcSecurityAuditRecord,
} from "@kokoro/platform-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  canonicalizeCreateVerificationTokenEffect,
  createVerificationTokenEffectDigest,
} from "../../src/generated/contracts/admin-auth-effect-digest.js";
import { CommandDigestAlgorithm } from "../../src/generated/contracts/kokoro/common/v1/receipt_pb.js";
import {
  AdminAuthService,
  CreateVerificationTokenEffectSchema,
} from "../../src/generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";
import { KokoroErrorDetailSchema } from "../../src/generated/contracts/kokoro/common/v1/error_pb.js";
import { createAdminServer, type AdminServerDeps } from "../../src/server.js";
import type {
  AdminAuthReceiptRecord,
  AdminAuthStore,
  AdminAuthTransaction,
} from "../../src/admin-auth-store.js";

const currentSecret = "test-current-secret";
const expires = new Date("2030-01-02T03:14:05.000Z");

class ConnectTestStore implements AdminAuthStore {
  receipts = new Map<string, AdminAuthReceiptRecord>();
  tokens = new Map<string, { identifier: string; token: string; expires: Date }>();

  async findOperatorByEmail(email: string) {
    if (email === "delay@example.test") await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      id: "operator-1",
      email,
      displayName: "Platform Operator",
      status: "active" as const,
    };
  }

  async findOperatorById(id: string) {
    return {
      id,
      email: "operator@example.test",
      displayName: "Platform Operator",
      status: "active" as const,
    };
  }

  async findReceiptByCommandId(commandId: string) {
    return this.receipts.get(commandId) ?? null;
  }

  async transaction<T>(run: (transaction: AdminAuthTransaction) => Promise<T>): Promise<T> {
    const transaction: AdminAuthTransaction = {
      findReceiptByCommandId: async (commandId) => this.receipts.get(commandId) ?? null,
      findReceiptByIdempotencyKey: async (idempotencyKey) =>
        [...this.receipts.values()].find((receipt) => receipt.idempotencyKey === idempotencyKey) ?? null,
      createReceipt: async (receipt) => {
        const created: AdminAuthReceiptRecord = { ...receipt, state: "accepted", result: null };
        this.receipts.set(created.commandId, created);
        return created;
      },
      commitReceipt: async (commandId, result, recordedAt) => {
        const existing = this.receipts.get(commandId);
        if (existing === undefined) throw new Error("missing receipt");
        const committed: AdminAuthReceiptRecord = { ...existing, state: "committed", result, recordedAt };
        this.receipts.set(commandId, committed);
        return committed;
      },
      createVerificationToken: async (value) => {
        this.tokens.set(`${value.identifier}:${value.token}`, value);
        return value;
      },
      consumeVerificationToken: async ({ identifier, token }) => {
        const key = `${identifier}:${token}`;
        const value = this.tokens.get(key) ?? null;
        this.tokens.delete(key);
        return value;
      },
      recordAuthEvent: async () => undefined,
    };
    return run(transaction);
  }
}

function metadata(values: Partial<Record<string, string>> = {}): Interceptor {
  return (next) => async (request) => {
    request.header.set(WORKLOAD_ID_HEADER, values[WORKLOAD_ID_HEADER] ?? "admin-web");
    request.header.set(WORKLOAD_AUDIENCE_HEADER, values[WORKLOAD_AUDIENCE_HEADER] ?? "admin-web");
    request.header.set(WORKLOAD_ENVIRONMENT_HEADER, values[WORKLOAD_ENVIRONMENT_HEADER] ?? "test");
    request.header.set(WORKLOAD_SECRET_HEADER, values[WORKLOAD_SECRET_HEADER] ?? currentSecret);
    return next(request);
  };
}

function makeClient(baseUrl: string, interceptors: Interceptor[] = []) {
  return createClient(
    AdminAuthService,
    createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors }),
  );
}

async function codeOf(promise: Promise<unknown>): Promise<Code> {
  try {
    await promise;
    throw new Error("expected ConnectError");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    return (error as ConnectError).code;
  }
}

async function errorOf(promise: Promise<unknown>): Promise<ConnectError> {
  try {
    await promise;
    throw new Error("expected ConnectError");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    return error as ConnectError;
  }
}

describe("Admin Auth generated Connect provider over HTTP/1.1", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let store: ConnectTestStore;
  let rpcMetrics: RpcMetricLabels[];
  let rpcAudit: RpcSecurityAuditRecord[];

  beforeEach(async () => {
    store = new ConnectTestStore();
    // 每个 server 实例记录进自己的数组，再暴露给用例读。
    // WHY 不直接 push 外层 let：deadline 用例用 timeoutMs:1 放弃一个 handler 里 sleep 50ms 的调用，
    // 客户端早已断开但服务端仍会跑完并记一条 rpc_outcome。若闭包捕获的是外层变量，那条迟到记录会
    // 落进下一个用例 beforeEach 新建的数组里，让断言多出一条 rpc_outcome——同一 SHA 时绿时红。
    // 绑定到本次实例的局部数组后，迟到记录只能落回它自己的数组，跨用例泄漏不可表达。
    const metrics: RpcMetricLabels[] = [];
    const audit: RpcSecurityAuditRecord[] = [];
    rpcMetrics = metrics;
    rpcAudit = audit;
    app = createAdminServer([], {
      audit: { record: async () => undefined },
      resolveOperator: async () => {
        throw new Error("unused");
      },
      authenticate: async () => {
        throw new Error("unused");
      },
      prisma: {} as AdminServerDeps["prisma"],
      approvalGrantThresholdMicros: 100_000_000n,
      adminAuth: {
        store,
        workload: {
          workload: "admin-web",
          audience: "admin-web",
          environment: "test",
          secrets: [currentSecret, "test-previous-secret"],
        },
        telemetry: {
          metrics: {
            recordRequest: (labels) => {
              metrics.push(labels);
            },
            observeDuration: () => undefined,
          },
          audit: {
            record: (record) => {
              audit.push(record);
            },
          },
        },
      },
    } as AdminServerDeps);
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves generated unary methods and keeps email in the request body", async () => {
    const client = makeClient(baseUrl, [metadata()]);
    const response = await client.getOperatorByEmail({ email: "Operator@Example.Test" });
    expect(response.operator?.email).toBe("operator@example.test");
  });

  it("exposes the Prometheus scrape surface", async () => {
    const response = await fetch(`${baseUrl}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("returns canonical codes for missing credentials, wrong audience, and deadline", async () => {
    const missing = await errorOf(makeClient(baseUrl).getOperator({ id: "operator-1" }));
    expect(missing.code).toBe(Code.Unauthenticated);
    expect(missing.findDetails(KokoroErrorDetailSchema)).toMatchObject([
      { domainCode: "workload.unauthenticated", safeMessage: "Workload authentication failed" },
    ]);
    expect(
      await codeOf(
        makeClient(baseUrl, [metadata({ [WORKLOAD_AUDIENCE_HEADER]: "other" })]).getOperator({ id: "operator-1" }),
      ),
    ).toBe(Code.PermissionDenied);
    expect(
      await codeOf(
        makeClient(baseUrl, [metadata()]).getOperatorByEmail({ email: "delay@example.test" }, { timeoutMs: 1 }),
      ),
    ).toBe(Code.DeadlineExceeded);
  });

  it("returns a typed safe validation detail without echoing request data", async () => {
    const error = await errorOf(makeClient(baseUrl, [metadata()]).getOperatorByEmail({ email: "pi" }));
    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.findDetails(KokoroErrorDetailSchema)).toMatchObject([
      { domainCode: "request.invalid", safeMessage: "Invalid request" },
    ]);
    expect(error.rawMessage).not.toContain("pi");
  });

  it("records safe auth, validation, and success RPC outcomes", async () => {
    await codeOf(makeClient(baseUrl).getOperator({ id: "secret-command-id" }));
    await codeOf(makeClient(baseUrl, [metadata()]).getOperatorByEmail({ email: "pi" }));
    await makeClient(baseUrl, [metadata()]).getOperatorByEmail({ email: "private-operator@example.test" });

    expect(rpcAudit.map((record) => record.event)).toEqual([
      "workload_auth_failure",
      "rpc_outcome",
      "validation_failure",
      "rpc_outcome",
      "rpc_outcome",
    ]);
    expect(rpcMetrics.map((labels) => labels.code)).toEqual(["unauthenticated", "invalid_argument", "ok"]);
    expect(rpcMetrics).toHaveLength(3);
    const serialized = JSON.stringify({ rpcMetrics, rpcAudit });
    for (const value of [
      currentSecret,
      "private-operator@example.test",
      "raw-verification-token",
      "secret-command-id",
      "a".repeat(64),
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("rejects an oversized unauthenticated message before handler dispatch", async () => {
    expect(await codeOf(makeClient(baseUrl).getOperator({ id: "x".repeat(32 * 1024) }))).toBe(
      Code.ResourceExhausted,
    );
  });

  it("reconciles a committed effect through GetCommandReceipt without returning the token", async () => {
    const client = makeClient(baseUrl, [metadata()]);
    const effect = canonicalizeCreateVerificationTokenEffect(
      create(CreateVerificationTokenEffectSchema, {
        identifier: "Operator@Example.Test",
        token: "raw-verification-token",
        expires: timestampFromDate(expires),
      }),
    );
    const requestDigest = createVerificationTokenEffectDigest(effect);
    await client.createVerificationToken({
      command: {
        commandId: "command-1",
        idempotencyKey: "idempotency-1",
        digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
        requestDigest,
      },
      effect,
    });
    const receipt = await client.getCommandReceipt({
      commandId: "command-1",
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest,
    });
    expect(receipt.receipt?.state).not.toBe(0);
    expect(receipt.result.case).toBe("verificationToken");
    expect(JSON.stringify(receipt, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))).not.toContain(
      "raw-verification-token",
    );
  });
});
