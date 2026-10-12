import { describe, expect, it, vi } from "vitest";
import { httpTransport, TransportError } from "../src/browser/transport.js";

function responding(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }));
}

describe("httpTransport", () => {
  it("posts each call as JSON to the one endpoint, with the page's cookies", async () => {
    const f = responding(201, { id: "v1", flow: "dc_api", status: "pending" });
    const t = httpTransport("/api/verify", { fetch: f as unknown as typeof fetch, headers: { "x-csrf": "t" } });
    await t.start("dc_api");
    await t.status("v1");
    await t.exchange("v1", "code");
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(["/api/verify", "/api/verify", "/api/verify"]);
    expect(calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { action: "start", flow: "dc_api" },
      { action: "status", id: "v1" },
      { action: "exchange", id: "v1", responseCode: "code" },
    ]);
    const first = calls[0] as [string, RequestInit];
    expect(first[1].credentials).toBe("same-origin");
    expect((first[1].headers as Record<string, string>)["x-csrf"]).toBe("t");
  });

  it("throws the server's error with its status and Retry-After", async () => {
    const f = responding(429, { error: "slow down" }, { "retry-after": "3" });
    const t = httpTransport("/api/verify", { fetch: f as unknown as typeof fetch });
    const error = await t.status("v1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).status).toBe(429);
    expect((error as TransportError).message).toBe("slow down");
    expect((error as TransportError).retryAfterSeconds).toBe(3);
  });

  it("refuses an answer that is not a JSON object", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 200 }));
    const t = httpTransport("/api/verify", { fetch: f as unknown as typeof fetch });
    await expect(t.status("v1")).rejects.toBeInstanceOf(TransportError);
  });
});
