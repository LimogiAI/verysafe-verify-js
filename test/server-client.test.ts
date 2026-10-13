import { describe, expect, it, vi } from "vitest";
import { createClient, VerySafeApiError } from "../src/server/client.js";

function responding(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
}

describe("createClient", () => {
  it("refuses a plain-http verifier off this machine, and an empty key", () => {
    expect(() => createClient({ baseUrl: "http://verify.example", apiKey: "k" })).toThrow(/https/);
    expect(() => createClient({ baseUrl: "https://verify.example", apiKey: "" })).toThrow(/apiKey/);
    expect(() => createClient({ baseUrl: "https://verify.example/?x=1", apiKey: "k" })).toThrow(/origin and a path/);
    expect(createClient({ baseUrl: "http://127.0.0.1:8787/", apiKey: "k" }).baseUrl).toBe("http://127.0.0.1:8787");
  });

  it("starts with the key in x-api-key and the body as the verifier's API wants it", async () => {
    const f = responding(201, {
      id: "v1",
      status: "pending",
      flow: "same_device",
      authorizationRequestUri: "openid4vp://x",
    });
    const client = createClient({
      baseUrl: "https://verify.example",
      apiKey: "secret",
      fetch: f as unknown as typeof fetch,
    });
    const started = await client.start({
      flow: "same_device",
      returnUrl: "https://shop.example/return",
      linkScheme: "haip-vp://",
      claims: ["age_over_18"],
    });
    expect(started.id).toBe("v1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://verify.example/v1/verifications");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toMatch(/^verysafe-verify\/\d/);
    expect(JSON.parse(String(init.body))).toEqual({
      flow: "same_device",
      returnUrl: "https://shop.example/return",
      linkScheme: "haip-vp://",
      claims: ["age_over_18"],
    });
  });

  it("reads and exchanges on the verification's own paths", async () => {
    const f = responding(200, {
      id: "v 1",
      status: "verified",
      flow: "same_device",
      result: { claims: { age_over_18: true } },
    });
    const client = createClient({
      baseUrl: "https://verify.example",
      apiKey: "secret",
      fetch: f as unknown as typeof fetch,
    });
    await client.read("v 1");
    const v = await client.exchange("v 1", "c0de");
    expect(v.result).toEqual({ claims: { age_over_18: true } });
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe("https://verify.example/v1/verifications/v%201");
    expect(calls[0]?.[1].method).toBe("GET");
    expect(calls[1]?.[0]).toBe("https://verify.example/v1/verifications/v%201/exchange");
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ responseCode: "c0de" });
  });

  it("throws the verifier's error with its status and Retry-After", async () => {
    const f = responding(429, { error: "budget" }, { "retry-after": "7" });
    const client = createClient({
      baseUrl: "https://verify.example",
      apiKey: "secret",
      fetch: f as unknown as typeof fetch,
    });
    const error = await client.read("v1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerySafeApiError);
    expect((error as VerySafeApiError).status).toBe(429);
    expect((error as VerySafeApiError).error).toBe("budget");
    expect((error as VerySafeApiError).retryAfterSeconds).toBe(7);
  });
});
