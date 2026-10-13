// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StartOptions, type Transport, TransportError } from "../src/browser/transport.js";
import { complete, DEFAULT_STORAGE_KEY, verify } from "../src/browser/verify.js";
import type { Flow, PageStart } from "../src/shared/types.js";

const PHONE = "Mozilla/5.0 (Linux; Android 16) Chrome/154.0.0.0 Mobile Safari/537.36";
const LAPTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/152.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";

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

function fakeTransport(
  statuses: string[] = ["verified"],
  promptProtocols: string[] = ["openid4vp-v1-signed"],
): Transport & {
  starts: Flow[];
  startOptions: (StartOptions | undefined)[];
  exchanges: [string, string][];
  statusReads: string[];
} {
  const starts: Flow[] = [];
  const startOptions: (StartOptions | undefined)[] = [];
  const exchanges: [string, string][] = [];
  const statusReads: string[] = [];
  let n = 0;
  return {
    starts,
    startOptions,
    exchanges,
    statusReads,
    async start(flow, options) {
      starts.push(flow);
      startOptions.push(options);
      const base: PageStart = { id: `v-${flow}`, flow, status: "pending" };
      if (flow === "dc_api")
        return {
          ...base,
          dcApiRequests: promptProtocols.map((protocol) => ({ protocol, data: { request: "jwt" } })),
          dcApiResponseUrl: "https://verifier.example/v1/verifications/v-dc_api/dc-api-response",
        };
      return { ...base, authorizationRequestUri: `openid4vp://?request_uri=https://verifier.example/${flow}` };
    },
    async status(id) {
      statusReads.push(id);
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
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("verify, the browser prompt", () => {
  it("asks the browser with the start's requests and relays its answer unopened, with no cookies and no key", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const get = vi.fn(async (request: object) => ({
      protocol: "openid4vp-v1-signed",
      data: { response: "jwe" },
      requests: (request as { digital: { requests: unknown[] } }).digital.requests,
    }));
    const relay = vi.fn(async () => new Response(JSON.stringify({ status: "verified" }), { status: 200 }));
    const flows: Flow[] = [];
    const result = await verify({
      transport: t,
      credentials: { get },
      fetch: relay as unknown as typeof fetch,
      onFlow: (f) => flows.push(f),
    });
    expect(result).toEqual({ outcome: "verified", id: "v-dc_api", flow: "dc_api" });
    expect(t.starts).toEqual(["dc_api"]);
    expect(t.statusReads).toEqual(["v-dc_api"]);
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

  it("tells the customer's server which prompt protocols this browser allows, in order, and the page's origin (J5)", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const get = vi.fn(async () => ({ protocol: "openid4vp-v1-signed", data: { response: "jwe" } }));
    await verify({
      transport: t,
      credentials: { get },
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(t.startOptions).toEqual([
      { dcApiProtocols: ["openid4vp-v1-signed", "org-iso-mdoc"], dcApiOrigin: location.origin },
    ]);
    const ordered = fakeTransport();
    await verify({
      transport: ordered,
      credentials: { get },
      protocols: ["org-iso-mdoc", "openid4vp-v1-signed"],
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(ordered.startOptions[0]?.dcApiProtocols).toEqual(["org-iso-mdoc", "openid4vp-v1-signed"]);
  });

  it("runs the prompt on an iPhone in Safari with the ISO mdoc protocol alone, and relays its answer", async () => {
    setBrowser({ userAgent: IPHONE, api: { allows: (p) => p === "org-iso-mdoc" } });
    const t = fakeTransport(["verified"], ["org-iso-mdoc"]);
    const get = vi.fn(async () => ({ protocol: "org-iso-mdoc", data: { response: "cbor" } }));
    const relay = vi.fn(async () => new Response(JSON.stringify({ status: "verified" }), { status: 200 }));
    const result = await verify({ transport: t, credentials: { get }, fetch: relay as unknown as typeof fetch });
    expect(result).toEqual({ outcome: "verified", id: "v-dc_api", flow: "dc_api" });
    expect(t.startOptions[0]?.dcApiProtocols).toEqual(["org-iso-mdoc"]);
    expect(get).toHaveBeenCalledTimes(1);
    const [, init] = relay.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ protocol: "org-iso-mdoc", data: { response: "cbor" } });
  });

  it("falls back to a link before the prompt when the start offers no protocol this browser allows: Safari and a credential that is not an mdoc", async () => {
    setBrowser({ userAgent: IPHONE, api: { allows: (p) => p === "org-iso-mdoc" } });
    const t = fakeTransport(["verified"], ["openid4vp-v1-signed"]);
    const get = vi.fn(async () => null);
    const navigate = vi.fn();
    const reasons: string[] = [];
    const result = await verify({ transport: t, credentials: { get }, navigate, onFallback: (r) => reasons.push(r) });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(get).not.toHaveBeenCalled();
    expect(reasons).toEqual(["The start offered no browser-prompt protocol this browser allows."]);
    expect(t.starts).toEqual(["dc_api", "same_device"]);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("after the relay, the customer's server reads the result itself, and its word is the page's outcome", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport(["failed"]);
    const relay = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await verify({
      transport: t,
      credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: {} }) },
      fetch: relay as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "failed", id: "v-dc_api", flow: "dc_api" });
    expect(t.statusReads).toEqual(["v-dc_api"]);
  });

  it("keeps the relay's verdict when the server's read fails", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const down: Transport = {
      ...t,
      status: async () => {
        throw new TransportError("down", 502);
      },
    };
    const relay = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await verify({
      transport: down,
      credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: {} }) },
      fetch: relay as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "verified", id: "v-dc_api", flow: "dc_api" });
  });

  it("uses a start made before the tap, so the prompt opens within the browser's activation window", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const prepared = await t.start("dc_api");
    t.starts.length = 0;
    const get = vi.fn(async () => ({ protocol: "openid4vp-v1-signed", data: {} }));
    const relay = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await verify({
      transport: t,
      prepared: Promise.resolve(prepared),
      credentials: { get },
      fetch: relay as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "verified", id: "v-dc_api", flow: "dc_api" });
    expect(t.starts).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("ignores a prepared start for another way", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const prepared = await t.start("same_device");
    t.starts.length = 0;
    const relay = vi.fn(async () => new Response("{}", { status: 200 }));
    await verify({
      transport: t,
      prepared,
      credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: {} }) },
      fetch: relay as unknown as typeof fetch,
    });
    expect(t.starts).toEqual(["dc_api"]);
  });

  it("parses an answer whose data is a string", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const relay = vi.fn(async () => new Response("{}", { status: 200 }));
    await verify({
      transport: fakeTransport(),
      credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: '{"response":"jwe"}' }) },
      fetch: relay as unknown as typeof fetch,
    });
    expect(JSON.parse(String((relay.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      protocol: "openid4vp-v1-signed",
      data: { response: "jwe" },
    });
  });

  it("reports the verifier's refusal of the relayed answer as failed, with the reason", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const relay = vi.fn(async () => new Response(JSON.stringify({ error: "wrong origin" }), { status: 400 }));
    const result = await verify({
      transport: fakeTransport(),
      credentials: { get: async () => ({ protocol: "openid4vp-v1-signed", data: {} }) },
      fetch: relay as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "failed", id: "v-dc_api", flow: "dc_api", reason: "wrong origin" });
  });

  it("does not open a wallet uninvited when the person dismisses the prompt: cancelled, with the way to offer next", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const error = new Error("dismissed");
    error.name = "NotAllowedError";
    const result = await verify({
      transport: t,
      credentials: {
        get: async () => {
          throw error;
        },
      },
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toEqual({
      outcome: "cancelled",
      id: "v-dc_api",
      flow: "dc_api",
      fallback: "same_device",
      reason: "NotAllowedError: dismissed",
    });
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
    const result = await verify({
      transport: t,
      credentials: {
        get: async () => {
          throw error;
        },
      },
      fetch: vi.fn() as unknown as typeof fetch,
      pollIntervalMs: 1,
      onFlow: (f) => flows.push(f),
      onStatus: (s) => statuses.push(s),
      renderQr: (uri) => rendered.push(uri),
    });
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
    const result = await verify({
      transport: refusing,
      credentials: { get: async () => null },
      fetch: vi.fn() as unknown as typeof fetch,
      navigate: () => {},
      onFallback: (r) => reasons.push(r),
    });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(reasons).toEqual(["The server refused a browser-prompt start: this page's origin is not registered"]);
    expect(t.starts).toEqual(["same_device"]);
  });

  it("does not swallow an outage of the customer's server", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const down: Transport = {
      ...t,
      start: async () => {
        throw new TransportError("gateway", 502);
      },
    };
    await expect(
      verify({ transport: down, credentials: { get: async () => null }, fetch: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/gateway/);
  });

  it("falls back when the browser answers with no credential", async () => {
    setBrowser({ userAgent: PHONE, api: { allows: () => true } });
    const t = fakeTransport();
    const result = await verify({
      transport: t,
      credentials: { get: async () => null },
      fetch: vi.fn() as unknown as typeof fetch,
      navigate: () => {},
    });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(t.starts).toEqual(["dc_api", "same_device"]);
  });
});

describe("verify, a link on a phone", () => {
  it("keeps the id in this browser's storage for the origin, where a return in a new tab still finds it, and opens the link", async () => {
    setBrowser({ userAgent: PHONE });
    const t = fakeTransport();
    const opened: string[] = [];
    const result = await verify({ transport: t, navigate: (url) => opened.push(url) });
    expect(result).toEqual({ outcome: "redirected", id: "v-same_device", flow: "same_device" });
    expect(opened).toEqual(["openid4vp://?request_uri=https://verifier.example/same_device"]);
    expect(JSON.parse(localStorage.getItem(DEFAULT_STORAGE_KEY) ?? "{}").id).toBe("v-same_device");
    expect(sessionStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });
});

describe("verify, a link on a phone: the tab that opened the wallet learns the result", () => {
  it("hears the return tab's announcement for its own id, once, and ignores others", async () => {
    setBrowser({ userAgent: PHONE });
    const t = fakeTransport();
    const heard: unknown[] = [];
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const windowObject = {
      addEventListener: (_type: string, l: EventListenerOrEventListenerObject) => void listeners.add(l),
      removeEventListener: (_type: string, l: EventListenerOrEventListenerObject) => void listeners.delete(l),
    };
    await verify({ transport: t, navigate: () => {}, onReturn: (r) => heard.push(r), windowObject });
    expect(listeners.size).toBe(1);
    const fire = (key: string, value: string) => {
      for (const l of [...listeners]) (l as EventListener)(new StorageEvent("storage", { key, newValue: value }));
    };
    fire("verysafe-verify:result", JSON.stringify({ id: "someone-else", outcome: "verified", at: 1 }));
    fire("other-key", JSON.stringify({ id: "v-same_device", outcome: "verified", at: 1 }));
    expect(heard).toEqual([]);
    fire("verysafe-verify:result", JSON.stringify({ id: "v-same_device", outcome: "verified", at: 1 }));
    expect(heard).toEqual([{ outcome: "verified", id: "v-same_device" }]);
    expect(listeners.size).toBe(0);
  });

  it("the return tab announces its outcome through the origin's storage", async () => {
    const t = fakeTransport();
    localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ id: "v-mine", at: Date.now() }));
    await complete({ transport: t, url: "https://shop.example/return?response_code=c0de", replaceUrl: () => {} });
    const announced = JSON.parse(localStorage.getItem("verysafe-verify:result") ?? "{}") as {
      id: string;
      outcome: string;
    };
    expect(announced.id).toBe("v-mine");
    expect(announced.outcome).toBe("verified");
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

  it("uses a start made ahead for the QR code too", async () => {
    setBrowser({ userAgent: LAPTOP });
    const t = fakeTransport();
    const prepared = await t.start("cross_device");
    t.starts.length = 0;
    const result = await verify({ transport: t, prepared, renderQr: () => {}, pollIntervalMs: 1 });
    expect(result).toEqual({ outcome: "verified", id: "v-cross_device", flow: "cross_device" });
    expect(t.starts).toEqual([]);
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
    localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ id: "v-mine", at: Date.now() }));
    const replaced: string[] = [];
    const result = await complete({
      transport: t,
      url: "https://shop.example/return?id=v-from-url&response_code=c0de",
      replaceUrl: (u) => replaced.push(u),
    });
    expect(result).toEqual({ outcome: "verified", id: "v-mine" });
    expect(t.exchanges).toEqual([["v-mine", "c0de"]]);
    expect(replaced).toEqual(["https://shop.example/return?id=v-from-url"]);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  it("ignores an id kept longer ago than the verifier keeps a verification", async () => {
    const t = fakeTransport();
    localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ id: "v-old", at: Date.now() - 16 * 60 * 1000 }));
    const result = await complete({
      transport: t,
      url: "https://shop.example/return?response_code=c0de",
      replaceUrl: () => {},
    });
    expect(result).toEqual({ outcome: "no_session" });
    expect(t.exchanges).toEqual([]);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  it("does nothing for a browser that arrives with a code but started nothing", async () => {
    const t = fakeTransport();
    const result = await complete({
      transport: t,
      url: "https://shop.example/return?response_code=c0de",
      replaceUrl: () => {},
    });
    expect(result).toEqual({ outcome: "no_session" });
    expect(t.exchanges).toEqual([]);
  });

  it("recognises a page that is not a return", async () => {
    expect(
      await complete({ transport: fakeTransport(), url: "https://shop.example/return", replaceUrl: () => {} }),
    ).toEqual({ outcome: "no_code" });
  });
});
