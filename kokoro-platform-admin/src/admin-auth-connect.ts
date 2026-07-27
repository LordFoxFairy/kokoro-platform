import { create } from "@bufbuild/protobuf";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import {
  createRpcErrorInterceptor,
  createRpcTelemetryInterceptor,
  createWorkloadAuthInterceptor,
  type RpcOutgoingDetails,
  type RpcTelemetryOptions,
  type SafeRpcErrorDetail,
  type WorkloadAuthOptions,
} from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import {
  KokoroErrorDetailSchema,
  RetryClass,
} from "./generated/contracts/kokoro/common/v1/error_pb.js";
import { AdminAuthService } from "./generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";
import { createAdminAuthService, type AdminAuthServiceOptions } from "./admin-auth-service.js";
import type { AdminAuthStore } from "./admin-auth-store.js";

export interface AdminAuthConnectConfig {
  store: AdminAuthStore;
  workload: WorkloadAuthOptions;
  telemetry: Omit<RpcTelemetryOptions, "identity">;
  service?: AdminAuthServiceOptions;
}

function retryClass(value: SafeRpcErrorDetail["retryClass"]): RetryClass {
  if (value === "after_delay") return RetryClass.AFTER_DELAY;
  if (value === "same_identity") return RetryClass.SAME_IDENTITY;
  if (value === "reconcile_receipt") return RetryClass.RECONCILE_RECEIPT;
  return RetryClass.NEVER;
}

export function createAdminAuthErrorDetails(detail: SafeRpcErrorDetail): RpcOutgoingDetails {
  return [
    {
      desc: KokoroErrorDetailSchema,
      value: create(KokoroErrorDetailSchema, {
        domainCode: detail.domainCode,
        retryClass: retryClass(detail.retryClass),
        requestId: detail.requestId ?? "",
        correlationId: detail.correlationId ?? "",
        safeMessage: detail.safeMessage,
        ...(detail.receiptRef === undefined ? {} : { receiptRef: detail.receiptRef }),
      }),
    },
  ];
}

export function registerAdminAuthConnect(app: FastifyInstance, config: AdminAuthConnectConfig): void {
  app.register(fastifyConnectPlugin, {
    acceptCompression: [],
    readMaxBytes: 16 * 1024,
    writeMaxBytes: 16 * 1024,
    maxTimeoutMs: 5_000,
    grpc: false,
    grpcWeb: false,
    routes: (router) => router.service(AdminAuthService, createAdminAuthService(config.store, config.service)),
    interceptors: [
      createRpcTelemetryInterceptor({ ...config.telemetry, identity: config.workload }),
      createRpcErrorInterceptor({ createDetails: createAdminAuthErrorDetails }),
      createWorkloadAuthInterceptor(config.workload),
      createValidateInterceptor(),
    ],
  });
}
