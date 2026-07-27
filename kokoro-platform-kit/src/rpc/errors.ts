import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";

export type RpcFailureKind =
  | "validation"
  | "authentication"
  | "permission"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "deadline";

export type RpcRetryClass = "never" | "after_delay" | "same_identity" | "reconcile_receipt";

export interface RpcFailureOptions {
  cause?: unknown;
  retryClass?: RpcRetryClass;
  receiptRef?: string;
}

export class RpcFailure extends Error {
  readonly kind: RpcFailureKind;
  readonly domainCode: string;
  readonly retryClass: RpcRetryClass;
  readonly receiptRef: string | undefined;

  constructor(kind: RpcFailureKind, domainCode: string, safeMessage: string, options: RpcFailureOptions = {}) {
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RpcFailure";
    this.kind = kind;
    this.domainCode = domainCode;
    this.retryClass = options.retryClass ?? "never";
    this.receiptRef = options.receiptRef;
  }
}

export interface SafeRpcErrorDetail {
  domainCode: string;
  retryClass: RpcRetryClass;
  safeMessage: string;
  requestId: string | undefined;
  correlationId: string | undefined;
  receiptRef: string | undefined;
}

export type RpcOutgoingDetails = NonNullable<ConstructorParameters<typeof ConnectError>[3]>;

export interface RpcErrorOptions {
  createDetails?: (detail: SafeRpcErrorDetail) => RpcOutgoingDetails;
  requestId?: string;
  correlationId?: string;
}

const codeByKind: Readonly<Record<RpcFailureKind, Code>> = {
  validation: Code.InvalidArgument,
  authentication: Code.Unauthenticated,
  permission: Code.PermissionDenied,
  not_found: Code.NotFound,
  conflict: Code.FailedPrecondition,
  unavailable: Code.Unavailable,
  deadline: Code.DeadlineExceeded,
};

const safeConnectDefaults: Partial<Record<Code, Pick<SafeRpcErrorDetail, "domainCode" | "safeMessage">>> = {
  [Code.InvalidArgument]: { domainCode: "request.invalid", safeMessage: "Invalid request" },
  [Code.Unauthenticated]: { domainCode: "workload.unauthenticated", safeMessage: "Workload authentication failed" },
  [Code.PermissionDenied]: { domainCode: "workload.permission_denied", safeMessage: "Workload permission denied" },
  [Code.NotFound]: { domainCode: "resource.not_found", safeMessage: "Resource not found" },
  [Code.FailedPrecondition]: { domainCode: "request.conflict", safeMessage: "Request conflict" },
  [Code.Unavailable]: { domainCode: "owner.unavailable", safeMessage: "Owner unavailable" },
  [Code.DeadlineExceeded]: { domainCode: "request.deadline_exceeded", safeMessage: "Request deadline exceeded" },
};

function safeReference(value: string | null): string | undefined {
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

export function toConnectError(error: unknown, options: RpcErrorOptions = {}): ConnectError {
  if (error instanceof ConnectError) {
    if (options.createDetails === undefined) return error;
    const safe = safeConnectDefaults[error.code] ?? {
      domainCode: "rpc.failed",
      safeMessage: "RPC request failed",
    };
    return new ConnectError(
      safe.safeMessage,
      error.code,
      error.metadata,
      options.createDetails({
        ...safe,
        retryClass: error.code === Code.DeadlineExceeded ? "reconcile_receipt" : "never",
        requestId: options.requestId,
        correlationId: options.correlationId,
        receiptRef: undefined,
      }),
      error.cause,
    );
  }
  if (error instanceof RpcFailure) {
    const detail: SafeRpcErrorDetail = {
      domainCode: error.domainCode,
      retryClass: error.retryClass,
      safeMessage: error.message,
      requestId: options.requestId,
      correlationId: options.correlationId,
      receiptRef: error.receiptRef,
    };
    return new ConnectError(
      error.message,
      codeByKind[error.kind],
      undefined,
      options.createDetails?.(detail) ?? [],
      error.cause,
    );
  }
  const internalDetail: SafeRpcErrorDetail = {
    domainCode: "rpc.internal",
    retryClass: "never",
    safeMessage: "Internal owner error",
    requestId: options.requestId,
    correlationId: options.correlationId,
    receiptRef: undefined,
  };
  return new ConnectError(
    internalDetail.safeMessage,
    Code.Internal,
    undefined,
    options.createDetails?.(internalDetail) ?? [],
    error,
  );
}

export function createRpcErrorInterceptor(options: Pick<RpcErrorOptions, "createDetails"> = {}): Interceptor {
  return (next) => async (request) => {
    try {
      return await next(request);
    } catch (error) {
      const errorOptions: RpcErrorOptions = {};
      const requestId = safeReference(request.header.get("x-request-id"));
      const correlationId = safeReference(request.header.get("x-correlation-id"));
      if (options.createDetails !== undefined) errorOptions.createDetails = options.createDetails;
      if (requestId !== undefined) errorOptions.requestId = requestId;
      if (correlationId !== undefined) errorOptions.correlationId = correlationId;
      throw toConnectError(error, errorOptions);
    }
  };
}
