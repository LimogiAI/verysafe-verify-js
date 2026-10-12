// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Transport, TransportError } from "../src/browser/transport.js";
import { complete, DEFAULT_STORAGE_KEY, verify } from "../src/browser/verify.js";
import type { Flow, PageStart } from "../src/shared/types.js";

const PHONE = "Mozilla/5.0 (Linux; Android 16) Chrome/154.0.0.0 Mobile Safari/537.36";
const LAPTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/152.0.0.0 Safari/537.36";

function setBrowser(options: { userAgent: string; api?: { allows?: (p: string) => boolean } }) {
  Object.defineProperty(navigator, "userAgent", { value: options.userAgent, configurable: true });
  const g = globalThis as Record<string, unknown>;
  if (options.api) {
    g.DigitalCredential = options.api.allows === undefined ? {} : { userAgentAllowsProtocol: options.api.allows };
    Object.defineProperty(navigator, "credentials", { value: { get: async () => null }, configurable: true });
  } else {
    delete g.DigitalCredential;
    Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
  }
}

function fakeTransport(statuses: string[] = ["verified"]): Transport & { starts: Flow[]; exchanges: [string, string][] } {
  const starts: Flow[] = [];
  const exchanges: [string, string][] = [];
  let n = 0;
  return {
    starts,
    exchanges,
    async start(flow) {
      starts.push(flow);
      const base: PageStart = { id: `v-${flow}`, flow, status: "pending" };
      if (flow === "dc_api") return { ...base, dcApiRequests: [{ protocol: "openid4vp-v1-signed", data: { request: "jwt" } }], dcApiResponseUrl: "https://verifier.example/v1/verifications/v-dc_api/dc-api-response" };
      return { ...base, authorizationRequestUri: `openid4vp://?request_uri=https://verifier.example/${flow}` };
    },
    async status(id) {
      const status = statuses[Math.min(n++, statuses.length - 1)] ?? "verified";
      return { id, status: status as PageStart["status"] };
    },
    async exchange(id, code) {
      exchanges.push([id, code]);
      return { id, status: "verified" };
    },
  };
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("verify, the browser prompt", () => {
  it("asks the browser with the start's requests and relays its answer unopened, with no cookies and no key", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const get = vi.fn(async (request: object) => ({ protocol: "openid4vp-v1-signed", data: { response: "jwe" }, requests: (request as { digital: { requests: unknown[] } }).digital.requests }));
    const relay = vi.fn(async () => new Response(JSON.stringify({ status: "verified" }), { status: 200 }));
    const flows: Flow[] = [];
    const result = await verify({ transport: t, credentials: { get }, fetch: relay as unknown as typeof fetch, onFlow: (f) => flows.push(f) });
    expect(result).toEqual({ outcome: "verified", id: "v-dc_api", flow: "dc_api" });
    expect(t.starts).toEqual(["dc_api"]);
    expect(flows).toEqual(["dc_api"]);
    const asked = (get.mock.calls[0] as unknown as [{ digital: { requests: unknown[] } }])[0];
    expect(asked.digital.requests).toEqual([{ protocol: "openid4vp-v1-signed", data: { request: "jwt" } }]);
    const [url, init] = relay.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://verifier.example/v1/verifications/v-dc_api/dc-api-response");
    expect(init.credentials).toBe("omit");
    expect(init.mode).toBe("cors");
    expect(JSON.parse(String(init.body))).toEqual({ protocol: "openid4vp-v1-signed", data: { response: "jwe" } });
    expect(JSON.stringify(init.headers)).not.toMatch(/api-key|authorization/i);
  });

  it("parses an answer whose data is a string", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const relay = vi.fn(async () => new Response("{}", { status: 200 }));
    await verify({ transport: fakeTransport(), credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: '{"response":"jwe"}' }) }, fetch: relay as unknown as typeof fetch });
    expect(JSON.parse(String((relay.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ protocol: "openid4vp-v1-signed", data: { response: "jwe" } });
  });

  it("reports the verifier's refusal of the relayed answer as failed, with the reason", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const relay = vi.fn(async () => new Response(JSON.stringify({ error: "wrong origin" }), { status: 400 }));
    const result = await verify({ transport: fakeTransport(), credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: {} }) }, fetch: relay as unknown as typeof fetch });
    expect(result).toEqual({ outcome: "failed", id: "v-dc_api", flow: "dc_api", reason: "wrong origin" });
  });

  it("does not open a wallet uninvited when the person dismisses the prompt: cancelled, with the way to offer next", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const error = new Error("dismissed");
    error.name = "NotAllowedError";
    const result = await verify({ transport: t, credentials: { get: async () => { throw error; } }, fetch: vi.fn() as unknown as typeof fetch });
    expect(result).toEqual({ outcome: "cancelled", id: "v-dc_api", flow: "dc_api", fallback: "same_device" });
    expect(t.starts).toEqual(["dc_api"]);
  });

  it("falls back to a QR code on a computer whose browser cannot do the prompt after all", async () => {
    setBrowser({ userAgent: LAPTOP, api: { allows: () => true } });
    const t = fakeTransport(["pending", "verified"]);
    const error = new Error("no");
    error.name = "NotSupportedError";
    const flows: Flow[] = [];
    const statuses: string[] = [];
    const rendered: string[] = [];
    const result = await verify({ transport: t, credentials: { get: async () => { throw error; } }, fetch: vi.fn() as unknown as typeof fetch, pollIntervalMs: 1, onFlow: (f) => flows.push(f), onStatus: (s) => statuses.push(s), renderQr: (uri) => rendered.push(uri) });
    expect(flows).toEqual(["dc_api", "cross_device"]);
    expect(t.starts).toEqual(["dc_api", "cross_device"]);
    expect(rendered).toEqual(["openid4vp://?request_uri=https://verifier.example/cross_device"]);
    expect(statuses).toEqual(["pending", "verified"]);
    expect(result).toEqual({ outcome: "verified", id: "v-cross_device", flow: "cross_device" });
  });

  it("falls back, and says why, when the customer's server refuses a prompt start", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const refusing: Transport = {
      ...t,
      start: async (flow) => {
        if (flow === "dc_api") throw new TransportError("this page's origin is not registered", 400);
        return t.start(flow);
      },
    };
    const reasons: string[] = [];
    const result = await verify({ transport: refusing, credentials: { get: async () => null }, fetch: vi.fn() as unknown as typeof fetch, navigate: () => {}, onFallback: (r) => reasons.push(r) });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(reasons).toEqual(["The server refused a browser-prompt start: this page's origin is not registered"]);
    expect(t.starts).toEqual(["same_device"]);
  });

  it("does not swallow an outage of the customer's server", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const down: Transport = { ...t, start: async () => { throw new TransportError("gateway", 502); } };
    await expect(verify({ transport: down, credentials: { get: async () => null }, fetch: vi.fn() as unknown as typeof fetch })).rejects.toThrow(/gateway/);
  });

  it("falls back when the browser answers with no credential", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const result = await verify({ transport: t, credentials: { get: async () => null }, fetch: vi.fn() as unknown as typeof fetch, navigate: () => {} });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(t.starts).toEqual(["dc_api", "same_device"]);
  });
});

describe("verify, a link on a phone", () => {
  it("keeps the id in this browser's session and opens the link", async () => {
    setBrowser({ userAgent: PHONE });
    const t = fakeTransport();
    const opened: string[] = [];
    const result = await verify({ transport: t, navigate: (url) => opened.push(url) });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(opened).toEqual(["openid4vp://?request_uri=https://verifier.example/same_device"]);
    expect(JSON.parse(sessionStorage.getItem(DEFAULT_STORAGE_KEY) ?? "{}").id).toBe("v-same_device");
  });
});

describe("verify, a QR code on a computer", () => {
  it("draws the code into the element and polls until the verifier has answered", async () => {
    setBrowser({ userAgent: LAPTOP });
    const t = fakeTransport(["pending", "pending", "failed"]);
    const el = document.createElement("div");
    const result = await verify({ transport: t, qrElement: el, pollIntervalMs: 1 });
    expect(result).toEqual({ outcome: "failed", id: "v-cross_device", flow: "cross_device" });
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("stops polling when aborted", async () => {
    setBrowser({ userAgent: LAPTOP });
    const t = fakeTransport(["pending"]);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 5);
    const result = await verify({ transport: t, renderQr: () => {}, pollIntervalMs: 1, signal: abort.signal });
    expect(result.outcome).toBe("cancelled");
  });

  it("honours a preferred flow over detection", async () => {
    setBrowser({ userAgent: PHONE });
    const t = fakeTransport();
    await verify({ transport: t, preferFlow: "cross_device", renderQr: () => {}, pollIntervalMs: 1 });
    expect(t.starts).toEqual(["cross_device"]);
  });
});

describe("complete, on the return page", () => {
  it("exchanges the code with the id from the session, never from the URL, and removes the code from the address", async () => {
    const t = fakeTransport();
    sessionStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ id: "v-mine", at: 1 }));
    const replaced: string[] = [];
    const result = await complete({ transport: t, url: "https://shop.example/return?id=v-from-url&response_code=c0de", replaceUrl: (u) => replaced.push(u) });
    expect(result).toEqual({ outcome: "verified", id: "v-mine" });
    expect(t.exchanges).toEqual([["v-mine", "c0de"]]);
    expect(replaced).toEqual(["https://shop.example/return?id=v-from-url"]);
    expect(sessionStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  it("does nothing for a browser that arrives with a code but started nothing", async () => {
    const t = fakeTransport();
    const result = await complete({ transport: t, url: "https://shop.example/return?response_code=c0de", replaceUrl: () => {} });
    expect(result).toEqual({ outcome: "no_session" });
    expect(t.exchanges).toEqual([]);
  });

  it("recognises a page that is not a return", async () => {
    expect(await complete({ transport: fakeTransport(), url: "https://shop.example/return", replaceUrl: () => {} })).toEqual({ outcome: "no_code" });
  });
});
