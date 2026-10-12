import type { Flow } from "../shared/types.js";
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

/**
 * `<verysafe-verify endpoint="/api/verify">`: a button that runs `verify` in
 * the order the library tries, a QR code when one is needed, and a status
 * line. On a return page it runs `complete` on its own. It dispatches
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
    if (new URL(location.href).searchParams.has("response_code")) void this.finish();
  }

  disconnectedCallback(): void {
    this.#abort?.abort();
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
    const preferFlow = this.getAttribute("prefer-flow");
    const pollAttribute = Number(this.getAttribute("poll-interval"));
    try {
      const result = await verify({
        transport: httpTransport(this.endpoint),
        qrElement: this.#qr,
        signal: abort.signal,
        ...(preferFlow === "dc_api" || preferFlow === "same_device" || preferFlow === "cross_device"
          ? { preferFlow: preferFlow as Flow }
          : {}),
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
      if (result.outcome !== "redirected") {
        this.#qr.classList.remove("on");
        this.#status.textContent = result.outcome === "cancelled" ? "" : result.outcome;
      }
      this.dispatchEvent(new CustomEvent("verysafe-verify:result", { detail: result, bubbles: true }));
      return result;
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
      this.#button.disabled = false;
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
