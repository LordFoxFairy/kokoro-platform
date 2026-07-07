// 跨服务通用错误码 → HTTP 状态的单一来源；业务专用码由业务仓用 AppError 自行携带。
export const ERROR_STATUS = {
  "request.invalid": 400,
  "auth.unauthenticated": 401,
  "auth.forbidden": 403,
  "resource.not_found": 404,
  "resource.conflict": 409,
  "rate.limited": 429,
  "upstream.unreachable": 502,
  "upstream.error": 502,
  "internal.error": 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

// 边界/领域错误的统一载体；全局 error handler 据 code/httpStatus 映射为错误信封。
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// 用登记的通用状态码构造 AppError，避免基础设施错误状态码漂移。
export function appError(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(code, ERROR_STATUS[code], message, details);
}
