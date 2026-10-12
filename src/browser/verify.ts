import { type Flow, isFinal, type PageStart, type VerificationStatus } from "../shared/types.js";
import { DEFAULT_PROTOCOLS, detect } from "./detect.js";
import type { Transport } from "./transport.js";

export interface VerifyOptions {
  /** The three calls to the customer's server. `httpTransport(endpoint)` for most pages. */
  transport: Transport;
  /** Where to draw the QR code when the person is on a computer whose browser has no prompt. */
  qrElement?: Element | null;
  /** Draws the QR code yourself instead of `qrElement`. Called with the link to encode. */
  renderQr?: (authorizationRequestUri: string, start: PageStart) => void;
  /** The browser-prompt protocols to ask the browser about. */
  protocols?: readonly string[];
  /** Skips detection and tries this way. For a page that knows better, or to retry after a cancel. */
  preferFlow?: Flow;
  /** How often to ask the customer's server about a QR code's verification; 2 seconds by default, which is the verifier's poll budget. */
  pollIntervalMs?: number;
  /** Stops a prompt or a poll. */
  signal?: AbortSignal;
  /** Called when the way is chosen, and again when the library falls back. */
  onFlow?: (flow: Flow) => void;
  /** Called with each status a poll returns. */
  onStatus?: (status: VerificationStatus) => void;
  /** Where the id of a same-device verification is kept until the person returns; `sessionStorage` by default. */
  storage?: Storage;
  /** The key in that storage. */
  storageKey?: string;
  /** Opens the wallet's link; `location.assign` by default. For tests. */
  navigate?: (url: string) => void;
  /** The browser's `navigator.credentials`; for tests. */
  credentials?: { get: (options: object) => Promise<unknown> };
  /** The fetch that relays the browser's answer to the verifier; the browser's by default. For tests. */
  fetch?: typeof fetch;
}

export type VerifyResult =
  /** The verifier answered. For `dc_api` the relay said so; for a QR code the customer's server did. The customer's server reads the result itself. */
  | { outcome: "verified" | "failed" | "expired"; id: string; flow: Flow; reason?: string }
  /** The wallet is opening on this phone. The person comes back to the return page, where `complete` finishes. */
  | { outcome: "redirected"; id: string; flow: "same_device" }
  /** The person dismissed the prompt, or the page aborted. `fallback` is the way to offer next, if the page wants to. */
  | { outcome: "cancelled"; id?: string; flow: Flow; fallback?: Flow };

export const DEFAULT_STORAGE_KEY = "verysafe-verify";

interface DigitalCredentialLike {
  protocol?: unknown;
  data?: unknown;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Aborted.");
  error.name = "AbortError";
  return error;
}

function errorName(error: unknown): string {
  return error !== null && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
}

/**
 * Tries the ways a person can present in the order EU law ranks them: the
 * browser prompt where the browser has it, else a link on a phone, else a QR
 * code. Each way starts through the customer's server, which holds the key;
 * the page only asks the browser, relays, or carries a code back.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const detection = detect({ protocols: options.protocols ?? DEFAULT_PROTOCOLS });
  let flow: Flow = options.preferFlow ?? detection.flow;
  const fallback: Flow = detection.phone ? "same_device" : "cross_device";

  if (flow === "dc_api") {
    options.onFlow?.(flow);
    const prompted = await browserPrompt(options);
    if (prompted.outcome !== "fallback") return prompted;
    flow = fallback;
  }

  options.onFlow?.(flow);
  if (flow === "same_device") return sameDevice(options);
  return crossDevice(options);
}

type PromptOutcome = VerifyResult | { outcome: "fallback" };

async function browserPrompt(options: VerifyOptions): Promise<PromptOutcome> {
  const start = await options.transport.start("dc_api");
  if (!Array.isArray(start.dcApiRequests) || typeof start.dcApiResponseUrl !== "string") {
    return { outcome: "fallback" };
  }
  const credentials = options.credentials ?? navigator.credentials;
  let credential: DigitalCredentialLike | null;
  try {
    const request: Record<string, unknown> = { digital: { requests: start.dcApiRequests } };
    if (options.signal !== undefined) request.signal = options.signal;
    credential = (await credentials.get(request)) as DigitalCredentialLike | null;
  } catch (error) {
    const name = errorName(error);
    // The person dismissed the prompt, or the page aborted: not a reason to open a wallet uninvited.
    if (name === "AbortError" || name === "NotAllowedError") {
      return { outcome: "cancelled", id: start.id, flow: "dc_api", fallback: detect().phone ? "same_device" : "cross_device" };
    }
    // The browser cannot do it after all (no protocol, no support): try the next way.
    return { outcome: "fallback" };
  }
  if (credential === null || typeof credential !== "object" || typeof credential.protocol !== "string") {
    return { outcome: "fallback" };
  }
  let data: unknown = credential.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return { outcome: "failed", id: start.id, flow: "dc_api", reason: "The browser's answer was not JSON." };
    }
  }
  const doFetch = options.fetch ?? fetch;
  const relayInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    mode: "cors",
    credentials: "omit",
    body: JSON.stringify({ protocol: credential.protocol, data }),
  };
  if (options.signal !== undefined) relayInit.signal = options.signal;
  const response = await doFetch(start.dcApiResponseUrl, relayInit);
  if (response.ok) return { outcome: "verified", id: start.id, flow: "dc_api" };
  let reason = `The verifier answered ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") reason = body.error;
  } catch {
    // The reason stays the status.
  }
  return { outcome: "failed", id: start.id, flow: "dc_api", reason };
}

async function sameDevice(options: VerifyOptions): Promise<VerifyResult> {
  const start = await options.transport.start("same_device");
  if (typeof start.authorizationRequestUri !== "string") {
    return { outcome: "failed", id: start.id, flow: "same_device", reason: "The start carried no link." };
  }
  const storage = options.storage ?? sessionStorage;
  storage.setItem(options.storageKey ?? DEFAULT_STORAGE_KEY, JSON.stringify({ id: start.id, at: Date.now() }));
  const navigate = options.navigate ?? ((url: string) => location.assign(url));
  navigate(start.authorizationRequestUri);
  return { outcome: "redirected", id: start.id, flow: "same_device" };
}

async function crossDevice(options: VerifyOptions): Promise<VerifyResult> {
  const start = await options.transport.start("cross_device");
  if (typeof start.authorizationRequestUri !== "string") {
    return { outcome: "failed", id: start.id, flow: "cross_device", reason: "The start carried no link." };
  }
  if (options.renderQr !== undefined) {
    options.renderQr(start.authorizationRequestUri, start);
  } else if (options.qrElement) {
    const { qrSvg } = await import("./qr.js");
    options.qrElement.replaceChildren(qrSvg(start.authorizationRequestUri, { title: "Scan with your EU wallet" }));
  }
  const interval = options.pollIntervalMs ?? 2000;
  for (;;) {
    try {
      await sleep(interval, options.signal);
    } catch {
      return { outcome: "cancelled", id: start.id, flow: "cross_device" };
    }
    const { status } = await options.transport.status(start.id);
    options.onStatus?.(status);
    if (isFinal(status)) return { outcome: status, id: start.id, flow: "cross_device" };
  }
}

export interface CompleteOptions {
  transport: Transport;
  /** The page's URL; `location.href` by default. */
  url?: string;
  storage?: Storage;
  storageKey?: string;
  /** Removes the code from the address bar; `history.replaceState` by default. */
  replaceUrl?: (url: string) => void;
}

export type CompleteResult =
  | { outcome: "verified" | "failed" | "expired" | "pending" | "awaiting_return"; id: string }
  /** The URL carries no `response_code`: this is not a return from the wallet. */
  | { outcome: "no_code" }
  /** A code arrived, but this browser session started no verification: nothing is exchanged, nothing is shown (HAIP §5.1). */
  | { outcome: "no_session" };

/**
 * On the return page: finishes a same-device verification. The id comes from
 * this browser's own session, never from the URL, and the customer's server
 * exchanges the code with it. A browser that arrives with a code but no
 * session gets nothing.
 */
export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const href = options.url ?? location.href;
  const url = new URL(href);
  const code = url.searchParams.get("response_code");
  if (code === null || code.length === 0) return { outcome: "no_code" };
  const storage = options.storage ?? sessionStorage;
  const key = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const kept = storage.getItem(key);
  let id: string | undefined;
  if (kept !== null) {
    try {
      const parsed = JSON.parse(kept) as { id?: unknown };
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      id = undefined;
    }
  }
  url.searchParams.delete("response_code");
  const replace = options.replaceUrl ?? ((next: string) => history.replaceState(history.state, "", next));
  replace(url.toString());
  if (id === undefined) return { outcome: "no_session" };
  storage.removeItem(key);
  const { status } = await options.transport.exchange(id, code);
  return { outcome: status, id };
}
