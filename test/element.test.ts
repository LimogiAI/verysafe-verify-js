// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineElement, VerySafeVerifyElement } from "../src/browser/element.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("<verysafe-verify>", () => {
  it("registers once", () => {
    defineElement();
    defineElement();
    expect(customElements.get("verysafe-verify")).toBe(VerySafeVerifyElement);
  });

  it("runs a QR-code verification from its button on a computer and reports the result as an event", async () => {
    defineElement();
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh) Chrome/152", configurable: true });
    let polls = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string };
      if (body.action === "start")
        return new Response(
          JSON.stringify({
            id: "v1",
            flow: "cross_device",
            status: "pending",
            authorizationRequestUri: "openid4vp://?request_uri=https://v.example/x",
          }),
          { status: 201 },
        );
      polls++;
      return new Response(JSON.stringify({ id: "v1", status: polls < 2 ? "pending" : "verified" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    el.setAttribute("endpoint", "/api/verify");
    el.setAttribute("poll-interval", "1000");
    document.body.appendChild(el);
    const results: unknown[] = [];
    el.addEventListener("verysafe-verify:result", (e) => results.push((e as CustomEvent).detail));
    const button = el.shadowRoot?.querySelector("button");
    expect(button?.textContent).toBe("Verify with your EU wallet");
    const run = el.run();
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector("svg")).not.toBeNull(), { timeout: 1000 });
    const result = await run;
    expect(result).toEqual({ outcome: "verified", id: "v1", flow: "cross_device" });
    expect(results).toEqual([result]);
    expect(el.shadowRoot?.querySelector("p")?.textContent).toBe("verified");
  }, 10_000);

  it("finishes a same-device return after the page's own scripts have had their turn", async () => {
    defineElement();
    localStorage.setItem("verysafe-verify", JSON.stringify({ id: "v9", at: Date.now() }));
    history.replaceState(null, "", "/?response_code=c0de");
    const actions: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string; id?: string; responseCode?: string };
      actions.push(body.action);
      if (body.action === "exchange") {
        expect(body).toEqual({ action: "exchange", id: "v9", responseCode: "c0de" });
        return new Response(JSON.stringify({ id: "v9", status: "verified" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "v10",
          flow: "cross_device",
          status: "pending",
          authorizationRequestUri: "openid4vp://x",
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    el.setAttribute("endpoint", "/api/verify");
    document.body.appendChild(el);
    const results: unknown[] = [];
    el.addEventListener("verysafe-verify:result", (e) => results.push((e as CustomEvent).detail));
    await vi.waitFor(() => expect(results).toEqual([{ outcome: "verified", id: "v9" }]));
    expect(location.search).toBe("");
    expect(localStorage.getItem("verysafe-verify")).toBeNull();
    // The return finished before any start was made ready, not after a wasted one.
    expect(actions[0]).toBe("exchange");
  });

  it("makes no start for a tab on its way to the wallet, and one again when the tab is shown", async () => {
    defineElement();
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 16) Chrome/154 Mobile",
      configurable: true,
    });
    const starts: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string; flow?: string };
      if (body.action === "start") starts.push(body.flow ?? "");
      return new Response(
        JSON.stringify({
          id: `v${starts.length}`,
          flow: "same_device",
          status: "pending",
          authorizationRequestUri: "openid4vp://x",
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    el.setAttribute("endpoint", "/api/verify");
    document.body.appendChild(el);
    await vi.waitFor(() => expect(starts).toEqual(["same_device"]));
    const result = await el.run();
    expect(result.outcome).toBe("redirected");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toEqual(["same_device"]);
    window.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() => expect(starts).toEqual(["same_device", "same_device"]));
  });

  it("starts the prompt's verification ahead of the tap, and the tap only opens the prompt", async () => {
    defineElement();
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 16) Chrome/154 Mobile",
      configurable: true,
    });
    (globalThis as Record<string, unknown>).DigitalCredential = { userAgentAllowsProtocol: () => true };
    const get = vi.fn(async () => ({ protocol: "openid4vp-v1-signed", data: { response: "jwe" } }));
    Object.defineProperty(navigator, "credentials", { value: { get }, configurable: true });
    const actions: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/dc-api-response")) return new Response("{}", { status: 200 });
      const body = JSON.parse(String(init.body)) as { action: string };
      actions.push(body.action);
      if (body.action === "start")
        return new Response(
          JSON.stringify({
            id: "v7",
            flow: "dc_api",
            status: "pending",
            dcApiRequests: [{ protocol: "openid4vp-v1-signed", data: {} }],
            dcApiResponseUrl: "https://verifier.example/v1/verifications/v7/dc-api-response",
          }),
          { status: 201 },
        );
      return new Response(JSON.stringify({ id: "v7", status: "verified" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    el.setAttribute("endpoint", "/api/verify");
    document.body.appendChild(el);
    await vi.waitFor(() => expect(actions).toEqual(["start"]));
    expect(get).not.toHaveBeenCalled();
    const result = await el.run();
    expect(result).toEqual({ outcome: "verified", id: "v7", flow: "dc_api" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(actions.filter((a) => a === "start")).toHaveLength(2); // the one used, and the next one made ready after the run
    delete (globalThis as Record<string, unknown>).DigitalCredential;
    Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
  });

  it("offers the prompt protocols its attribute lists, in that order, with the start made ahead, and the page's origin", async () => {
    defineElement();
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 16) Chrome/154 Mobile",
      configurable: true,
    });
    (globalThis as Record<string, unknown>).DigitalCredential = { userAgentAllowsProtocol: () => true };
    Object.defineProperty(navigator, "credentials", { value: { get: vi.fn(async () => null) }, configurable: true });
    const starts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.action === "start") starts.push(body);
        return new Response(
          JSON.stringify({
            id: "v8",
            flow: "dc_api",
            status: "pending",
            dcApiRequests: [],
            dcApiResponseUrl: "https://verifier.example/r",
          }),
          { status: 201 },
        );
      }),
    );
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    el.setAttribute("endpoint", "/api/verify");
    el.setAttribute("protocols", "org-iso-mdoc, openid4vp-v1-signed");
    document.body.appendChild(el);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({
      action: "start",
      flow: "dc_api",
      dcApiProtocols: ["org-iso-mdoc", "openid4vp-v1-signed"],
      dcApiOrigin: location.origin,
    });
    delete (globalThis as Record<string, unknown>).DigitalCredential;
    Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
  });

  it("refuses to run without an endpoint", async () => {
    defineElement();
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    document.body.appendChild(el);
    await expect(el.run()).rejects.toThrow(/endpoint/);
  });
});
