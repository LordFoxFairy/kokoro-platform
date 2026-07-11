import { AppError } from "@kokoro/platform-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCreditGrantClient } from "../../src/infrastructure/credit-grant-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const grantInput = {
  siteId: "site_1",
  requestId: "req_1",
  ownerKind: "team",
  ownerId: "team_1",
  amountMicros: "1000000",
  idempotencyKey: "order:order_1",
  reason: "subscription",
} as const;

function headerOf(init: RequestInit | undefined, key: string): string | null {
  return new Headers(init?.headers).get(key);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCreditGrantClient", () => {
  it("ensures account then grants with the returned accountId", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: "acc_42" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "entry_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createCreditGrantClient("http://credit:4231/", "sec")(grantInput);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ensureCall = fetchMock.mock.calls[0];
    const grantCall = fetchMock.mock.calls[1];
    if (!ensureCall || !grantCall) {
      throw new Error("expected two fetch calls");
    }
    expect(ensureCall[0]).toBe("http://credit:4231/credit/accounts/ensure");
    expect(JSON.parse(String(ensureCall[1]?.body))).toEqual({
      ownerKind: "team",
      ownerId: "team_1",
    });

    expect(grantCall[0]).toBe("http://credit:4231/credit/grant");
    expect(JSON.parse(String(grantCall[1]?.body))).toEqual({
      accountId: "acc_42",
      amountMicros: "1000000",
      idempotencyKey: "order:order_1",
      reason: "subscription",
    });

    // 归队 callService 后：两次调用都须带站点/请求 id + 内部密钥 + system principal(链路 + 服务间认证)。
    for (const call of [ensureCall, grantCall]) {
      expect(headerOf(call[1], "x-kokoro-site-id")).toBe("site_1");
      expect(headerOf(call[1], "x-kokoro-request-id")).toBe("req_1");
      expect(headerOf(call[1], "x-kokoro-internal-secret")).toBe("sec");
      expect(JSON.parse(String(headerOf(call[1], "x-kokoro-principal")))).toEqual({ kind: "system" });
    }
  });

  it("maps non-2xx ensure to an AppError via callService envelope and never calls grant", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { code: "credit.site_required", message: "缺少站点上下文" } }, 400),
      );
    vi.stubGlobal("fetch", fetchMock);

    // 错误信封被 callService 解析回 AppError(code/httpStatus 保真)，而非旧的裸 Error 字符串。
    const error = await createCreditGrantClient("http://credit:4231")(grantInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "credit.site_required", httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只打了 ensure，未触及 grant
  });

  it("maps non-2xx grant to an AppError", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: "acc_42" } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "credit.insufficient", message: "积分余额不足" } }, 402),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await createCreditGrantClient("http://credit:4231")(grantInput).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "credit.insufficient", httpStatus: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed ensure payload missing data.id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCreditGrantClient("http://credit:4231")(grantInput)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits internal-secret header when secret unconfigured", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: "acc_42" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: "entry_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createCreditGrantClient("http://credit:4231")(grantInput);

    const ensureCall = fetchMock.mock.calls[0];
    expect(headerOf(ensureCall?.[1], "x-kokoro-internal-secret")).toBeNull();
  });
});
