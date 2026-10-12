// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineElement, VerySafeVerifyElement } from "../src/browser/element.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
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
      if (body.action === "start") return new Response(JSON.stringify({ id: "v1", flow: "cross_device", status: "pending", authorizationRequestUri: "openid4vp://?request_uri=https://v.example/x" }), { status: 201 });
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

  it("refuses to run without an endpoint", async () => {
    defineElement();
    const el = document.createElement("verysafe-verify") as VerySafeVerifyElement;
    document.body.appendChild(el);
    await expect(el.run()).rejects.toThrow(/endpoint/);
  });
});
