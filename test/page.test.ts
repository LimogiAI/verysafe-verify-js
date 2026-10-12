import { describe, expect, it, vi } from "vitest";
import { createClient, VerySafeApiError } from "../src/server/client.js";
import { handlePageRequest } from "../src/server/page.js";

function clientWith(answers: Record<string, unknown>) {
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const answer = answers[key];
    if (answer instanceof VerySafeApiError) return new Response(JSON.stringify({ error: answer.error }), { status: answer.status, headers: answer.retryAfterSeconds ? { "retry-after": String(answer.retryAfterSeconds) } : {} });
    if (answer === undefined) return new Response(JSON.stringify({ error: `unexpected ${key}` }), { status: 500 });
    return new Response(JSON.stringify(answer), { status: init.method === "POST" && !url.endsWith("/exchange") ? 201 : 200 });
  });
  return { client: createClient({ baseUrl: "https://verify.example", apiKey: "secret", fetch: f as unknown as typeof fetch }), f };
}

const STARTED = { id: "v1", status: "pending", flow: "dc_api", credentialType: "eu_pid", requestedClaims: ["given_name"], dcApiRequests: [{ protocol: "openid4vp-v1-signed", data: {} }], dcApiResponseUrl: "https://verify.example/v1/verifications/v1/dc-api-response", pollUrl: "https://verify.example/v1/verifications/v1", reference: "order-1" };

describe("handlePageRequest", () => {
  it("refuses anything but the three calls", async () => {
    const { client, f } = clientWith({});
    expect((await handlePageRequest(client, null)).status).toBe(400);
    expect((await handlePageRequest(client, { action: "read" })).status).toBe(400);
    expect((await handlePageRequest(client, { action: "start", flow: "magic" })).status).toBe(400);
    expect((await handlePageRequest(client, { action: "status" })).status).toBe(400);
    expect((await handlePageRequest(client, { action: "exchange", id: "v1" })).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("starts the browser prompt and gives the page only what it needs", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": STARTED });
    const result = await handlePageRequest(client, { action: "start", flow: "dc_api" }, { start: { claims: ["given_name"], linkScheme: "haip-vp://", reference: "order-1" } });
    expect(result.status).toBe(201);
    expect(result.reply).toEqual({ id: "v1", flow: "dc_api", status: "pending", dcApiRequests: STARTED.dcApiRequests, dcApiResponseUrl: STARTED.dcApiResponseUrl });
    expect(result.started).toEqual(STARTED);
    const sent = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(sent).toEqual({ flow: "dc_api", claims: ["given_name"], reference: "order-1" });
  });

  it("refuses a same-device start without a return page, before calling the verifier", async () => {
    const { client, f } = clientWith({});
    const result = await handlePageRequest(client, { action: "start", flow: "same_device" });
    expect(result.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the return page with a same-device start, and never with the others", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": { ...STARTED, flow: "same_device", authorizationRequestUri: "openid4vp://x" } });
    await handlePageRequest(client, { action: "start", flow: "same_device" }, { returnUrl: (flow) => `https://shop.example/return/${flow}`, start: { returnUrl: "https://ignored.example" } });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ flow: "same_device", returnUrl: "https://shop.example/return/same_device" });
    await handlePageRequest(client, { action: "start", flow: "cross_device" }, { returnUrl: "https://shop.example/return", start: { returnUrl: "https://ignored.example" } });
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ flow: "cross_device" });
  });

  it("offers only the flows allowed", async () => {
    const { client, f } = clientWith({});
    expect((await handlePageRequest(client, { action: "start", flow: "cross_device" }, { allowFlows: ["dc_api", "same_device"] })).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("answers a status with the status alone, and hands the claims to the server", async () => {
    const { client } = clientWith({ "GET /v1/verifications/v1": { id: "v1", status: "verified", flow: "cross_device", result: { claims: { given_name: "Test" } } } });
    const result = await handlePageRequest(client, { action: "status", id: "v1" });
    expect(result.status).toBe(200);
    expect(result.reply).toEqual({ id: "v1", status: "verified" });
    expect(JSON.stringify(result.reply)).not.toContain("Test");
    expect(result.verification?.result).toEqual({ claims: { given_name: "Test" } });
  });

  it("exchanges a code and hands the claims to the server, the page getting the status", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications/v1/exchange": { id: "v1", status: "verified", flow: "same_device", result: { claims: { given_name: "Test" } } } });
    const result = await handlePageRequest(client, { action: "exchange", id: "v1", responseCode: "c0de" });
    expect(result.reply).toEqual({ id: "v1", status: "verified" });
    expect(result.verification?.result).toEqual({ claims: { given_name: "Test" } });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ responseCode: "c0de" });
  });

  it("asks the server whether this session owns the verification", async () => {
    const { client, f } = clientWith({});
    const result = await handlePageRequest(client, { action: "status", id: "v1" }, { ownsVerification: async () => false });
    expect(result.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes the verifier's refusals through, and hides its key and outage errors", async () => {
    const budget = new VerySafeApiError(429, { error: "budget" }, 5);
    const { client } = clientWith({ "GET /v1/verifications/v1": budget });
    const result = await handlePageRequest(client, { action: "status", id: "v1" });
    expect(result).toEqual({ status: 429, reply: { error: "budget" } });

    const unauthorised = new VerySafeApiError(401, { error: "bad key" });
    const errors: unknown[] = [];
    const c2 = clientWith({ "GET /v1/verifications/v1": unauthorised });
    const r2 = await handlePageRequest(c2.client, { action: "status", id: "v1" }, { onError: (e) => errors.push(e) });
    expect(r2.status).toBe(502);
    expect(JSON.stringify(r2.reply)).not.toContain("bad key");
    expect(errors).toHaveLength(1);

    const c3 = clientWith({});
    expect((await handlePageRequest(c3.client, { action: "status", id: "v1" })).status).toBe(502);
  });
});
