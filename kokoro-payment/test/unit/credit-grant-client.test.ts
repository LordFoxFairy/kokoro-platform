import { afterEach, describe, expect, it, vi } from "vitest";
import { createCreditGrantClient } from "../../src/infrastructure/credit-grant-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const grantInput = {
  ownerKind: "team",
  ownerId: "team_1",
  amountMicros: "1000000",
  idempotencyKey: "order:order_1",
  reason: "subscription",
} as const;

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

    await createCreditGrantClient("http://credit:4231/")(grantInput);

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
  });

  it("throws when ensure responds non-2xx and never calls grant", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCreditGrantClient("http://credit:4231")(grantInput)).rejects.toThrow(
      "credit ensure failed: 500",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when grant responds non-2xx", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: "acc_42" } }))
      .mockResolvedValueOnce(jsonResponse({}, 402));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCreditGrantClient("http://credit:4231")(grantInput)).rejects.toThrow(
      "credit grant failed: 402",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed ensure payload missing data.id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCreditGrantClient("http://credit:4231")(grantInput)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
