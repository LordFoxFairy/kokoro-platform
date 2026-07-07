import { describe, expect, it } from "vitest";
import { AppError, ERROR_STATUS, appError } from "../src/domain/errors.js";

describe("AppError", () => {
  it("retains code, httpStatus, message, details and is an Error", () => {
    const err = new AppError("credit.insufficient", 402, "no balance", { need: 5n });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AppError");
    expect(err.code).toBe("credit.insufficient");
    expect(err.httpStatus).toBe(402);
    expect(err.message).toBe("no balance");
    expect(err.details).toEqual({ need: 5n });
  });

  it("leaves details undefined when omitted", () => {
    expect(new AppError("rate.limited", 429, "slow").details).toBeUndefined();
  });

  it("allows business modules to carry their own codes outside the generic registry", () => {
    const err = new AppError("owner.inactive", 409, "owner disabled");
    expect(err.code).toBe("owner.inactive");
    expect(err.httpStatus).toBe(409);
  });
});

describe("appError (registry-driven status)", () => {
  it.each([
    ["request.invalid", 400],
    ["auth.unauthenticated", 401],
    ["auth.forbidden", 403],
    ["resource.not_found", 404],
    ["resource.conflict", 409],
    ["rate.limited", 429],
    ["upstream.unreachable", 502],
    ["upstream.error", 502],
    ["internal.error", 500],
  ] as const)("maps %s -> %s", (code, status) => {
    expect(ERROR_STATUS[code]).toBe(status);
    expect(appError(code, "m").httpStatus).toBe(status);
    expect(appError(code, "m").code).toBe(code);
  });

  it("forwards details when provided, omits otherwise", () => {
    expect(appError("request.invalid", "bad", { field: "x" }).details).toEqual({ field: "x" });
    expect(appError("rate.limited", "slow").details).toBeUndefined();
  });

  it("keeps business-specific codes out of the generic registry", () => {
    const forbiddenPrefixes = ["credit.", "payment.", "site.", "owner.", "model.", "user."];
    expect(Object.keys(ERROR_STATUS).filter((code) => forbiddenPrefixes.some((prefix) => code.startsWith(prefix)))).toEqual([]);
  });
});
