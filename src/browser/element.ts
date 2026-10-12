import type { Flow, PageStart } from "../shared/types.js";
import { detect } from "./detect.js";
import { httpTransport } from "./transport.js";
import { complete, type CompleteResult, verify, type VerifyResult } from "./verify.js";

const STYLES = `
:host { display: inline-block; font: inherit; }
button { font: inherit; cursor: pointer; }
.qr { display: none; width: 12rem; height: 12rem; margin-top: 0.75rem; }
.qr.on { display: block; }
.qr svg { width: 100%; height: 100%; }
.status { margin-top: 0.5rem; }
`;

/** How long a start made ahead of the tap is kept before a fresh one is made: a link's request lives five minutes. */
export const DEFAULT_PREPARE_TTL_MS = 4 * 60 * 1000;

/**
 * `<verysafe-verify endpoint="/api/verify">`: a button that runs `verify` in
 * the order the library tries, a QR code when one is needed, and a status
 * line. Where the way to try is the prompt or a link, it starts the
 * verification ahead of the tap and refreshes it every few minutes, since
 * Chrome opens a prompt or a wallet only within seconds of the tap;
 * `prepare="off"` turns that off. On a return page it runs `complete` on its
 * own. It dispatches
 * `verysafe-verify:flow`, `verysafe-verify:fallback`, `verysafe-verify:status` and `verysafe-verify:result`
 * events, with the library's values in `detail`. Styles come through a
 * constructed stylesheet, so a strict Content Security Policy is no obstacle;
 * override them from the page with `::part(button)`, `::part(qr)` and
 * `::part(status)`.
 */
export class VerySafeVerifyElement extends HTMLElement {
  static readonly tagName = "verysafe-verify";
  static get observedAttributes(): string[] {
    return ["label"];
  }

  #button: HTMLButtonElement;
  #qr: HTMLDivElement;
  #status: HTMLParagraphElement;
  #abort: AbortController | undefined;
  #prepared: Promise<PageStart | undefined> | undefined;
  #prepareTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      // No constructed stylesheets: the host styles the parts.
    }
    this.#button = document.createElement("button");
    this.#button.type = "button";
    this.#button.setAttribute("part", "button");
    this.#button.addEventListener("click", () => void this.run());
    this.#qr = document.createElement("div");
    this.#qr.className = "qr";
    this.#qr.setAttribute("part", "qr");
    this.#status = document.createElement("p");
    this.#status.className = "status";
    this.#status.setAttribute("part", "status");
    this.#status.setAttribute("aria-live", "polite");
    shadow.append(this.#button, this.#qr, this.#status);
    this.#label();
  }

  attributeChangedCallback(): void {
    this.#label();
  }

  connectedCallback(): void {
    this.#label();
    if (new URL(location.href).searchParams.has("response_code")) {
      // A return page finishes first, after the page's own scripts have run so
      // that they see the result; a start is made ready only then.
      const finish = () => void this.finish().finally(() => this.#prepare());
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", finish, { once: true });
      else setTimeout(finish, 0);
    } else {
      this.#prepare();
    }
    window.addEventListener("pageshow", this.#onShow);
    document.addEventListener("visibilitychange", this.#onShow);
  }

  disconnectedCallback(): void {
    this.#abort?.abort();
    this.#dropPrepared();
    window.removeEventListener("pageshow", this.#onShow);
    document.removeEventListener("visibilitychange", this.#onShow);
  }

  /** A tab that handed off to the wallet and comes back to view gets a start ready again. */
  readonly #onShow = (): void => {
    if (document.visibilityState !== "hidden" && this.#prepared === undefined && this.#prepareTimer === undefined) {
      this.#prepare();
    }
  };

  #dropPrepared(): void {
    if (this.#prepareTimer !== undefined) clearTimeout(this.#prepareTimer);
    this.#prepareTimer = undefined;
    this.#prepared = undefined;
  }

  #preferredFlow(): Flow | undefined {
    const value = this.getAttribute("prefer-flow");
    return value === "dc_api" || value === "same_device" || value === "cross_device" ? value : undefined;
  }

  /** Starts ahead of the tap, for the prompt and for a link, and again before the start goes stale. */
  #prepare(): void {
    if (this.#prepareTimer !== undefined) clearTimeout(this.#prepareTimer);
    this.#prepareTimer = undefined;
    if (this.getAttribute("prepare") === "off" || !this.isConnected) return;
    const flow = this.#preferredFlow() ?? detect().flow;
    if (flow === "cross_device") return;
    let endpoint: string;
    try {
      endpoint = this.endpoint;
    } catch {
      return;
    }
    this.#prepared = httpTransport(endpoint)
      .start(flow)
      .then(
        (start) => start,
        () => undefined,
      );
    this.#prepareTimer = setTimeout(() => this.#prepare(), DEFAULT_PREPARE_TTL_MS);
  }

  #label(): void {
    this.#button.textContent = this.getAttribute("label") ?? "Verify with your EU wallet";
  }

  get endpoint(): string {
    const endpoint = this.getAttribute("endpoint");
    if (endpoint === null || endpoint.length === 0) throw new Error("<verysafe-verify> needs an endpoint attribute.");
    return endpoint;
  }

  /** Runs a verification, as the button does. */
  async run(): Promise<VerifyResult> {
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.#button.disabled = true;
    this.#qr.classList.remove("on");
    this.#qr.replaceChildren();
    this.#status.textContent = "";
    const preferFlow = this.#preferredFlow();
    const pollAttribute = Number(this.getAttribute("poll-interval"));
    const prepared = this.#prepared;
    this.#dropPrepared();
    let redirected = false;
    try {
      const result = await verify({
        transport: httpTransport(this.endpoint),
        qrElement: this.#qr,
        signal: abort.signal,
        ...(prepared === undefined ? {} : { prepared }),
        ...(preferFlow === undefined ? {} : { preferFlow }),
        ...(Number.isFinite(pollAttribute) && pollAttribute >= 1000 ? { pollIntervalMs: pollAttribute } : {}),
        onFlow: (flow) => {
          if (flow === "cross_device") this.#qr.classList.add("on");
          this.dispatchEvent(new CustomEvent("verysafe-verify:flow", { detail: { flow }, bubbles: true }));
        },
        onFallback: (reason) => {
          this.dispatchEvent(new CustomEvent("verysafe-verify:fallback", { detail: { reason }, bubbles: true }));
        },
        onStatus: (status) => {
          this.#status.textContent = status === "pending" ? "Waiting for your wallet…" : status;
          this.dispatchEvent(new CustomEvent("verysafe-verify:status", { detail: { status }, bubbles: true }));
        },
      });
      redirected = result.outcome === "redirected";
      if (!redirected) {
        this.#qr.classList.remove("on");
        this.#status.textContent = result.outcome === "cancelled" ? "" : result.outcome;
      }
      this.dispatchEvent(new CustomEvent("verysafe-verify:result", { detail: result, bubbles: true }));
      return result;
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
      this.#button.disabled = false;
      // A tab on its way to the wallet needs no start; one is made ready when it is shown again.
      if (!redirected) this.#prepare();
    }
  }

  /** Finishes a same-device verification on the return page, as `connectedCallback` does. */
  async finish(): Promise<CompleteResult> {
    const result = await complete({ transport: httpTransport(this.endpoint) });
    if ("id" in result) this.#status.textContent = result.outcome;
    this.dispatchEvent(new CustomEvent("verysafe-verify:result", { detail: result, bubbles: true }));
    return result;
  }
}

/** Registers `<verysafe-verify>` once. Safe to call twice. */
export function defineElement(registry: CustomElementRegistry = customElements): void {
  if (registry.get(VerySafeVerifyElement.tagName) === undefined) {
    registry.define(VerySafeVerifyElement.tagName, VerySafeVerifyElement);
  }
}
