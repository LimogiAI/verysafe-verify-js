import { type Flow, isFinal, type PageStart, type VerificationStatus } from "../shared/types.js";
import { DEFAULT_PROTOCOLS, detect, type Detection } from "./detect.js";
import { type StartOptions, type Transport, TransportError } from "./transport.js";

export interface VerifyOptions {
  /** The three calls to the customer's server. `httpTransport(endpoint)` for most pages. */
  transport: Transport;
  /** Where to draw the QR code when the person is on a computer whose browser has no prompt. */
  qrElement?: Element | null;
  /** Draws the QR code yourself instead of `qrElement`. Called with the link to encode. */
  renderQr?: (authorizationRequestUri: string, start: PageStart) => void;
  /**
   * The browser-prompt protocols to ask the browser about, in the order to
   * offer them; `DEFAULT_PROTOCOLS` by default. Those the browser allows go
   * to the customer's server with the start, which offers what it can.
   */
  protocols?: readonly string[];
  /** Skips detection and tries this way. For a page that knows better, or to retry after a cancel. */
  preferFlow?: Flow;
  /**
   * A start made before the tap, on page load. Chrome opens the prompt, and
   * a wallet's link, only within a few seconds of the person's tap: too short
   * for a start through the customer's server. So start ahead
   * (`transport.start(detect().flow)`), hand the result here, and refresh it
   * every few minutes; the element does this by itself. A prepared start for
   * another way than the one tried is ignored.
   */
  prepared?: PageStart | Promise<PageStart | undefined> | undefined;
  /** How often to ask the customer's server about a QR code's verification; 2 seconds by default, which is the verifier's poll budget. */
  pollIntervalMs?: number;
  /** Stops a prompt or a poll. */
  signal?: AbortSignal;
  /** Called when the way is chosen, and again when the library falls back. */
  onFlow?: (flow: Flow) => void;
  /** Called when the library falls back from the prompt, with why. */
  onFallback?: (reason: string) => void;
  /** Called with each status a poll returns. */
  onStatus?: (status: VerificationStatus) => void;
  /**
   * Same device only: called in the tab that opened the wallet when the tab
   * the wallet brought the person back to has finished the exchange, which
   * it announces through the browser's storage for the origin. Not in
   * Private Browsing, where tabs share nothing.
   */
  onReturn?: (result: { outcome: VerificationStatus; id: string }) => void;
  /** The window whose `storage` events announce a return; the page's by default. For tests. */
  windowObject?: Pick<Window, "addEventListener" | "removeEventListener">;
  /**
   * Where the id of a same-device verification is kept until the person
   * returns; `localStorage` by default. A wallet on Android brings the person
   * back in a new tab, which has no `sessionStorage` of its own, so the id is
   * kept for the page's origin, for `returnTtlMs`, and never in the URL.
   */
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
  /** The person dismissed the prompt, or the page aborted. `fallback` is the way to offer next, if the page wants to; `reason` is the browser's own error. */
  | { outcome: "cancelled"; id?: string; flow: Flow; fallback?: Flow; reason?: string };

export const DEFAULT_STORAGE_KEY = "verysafe-verify";

/** Where the return tab announces its outcome to the tab that opened the wallet. */
export const DEFAULT_RESULT_KEY = "verysafe-verify:result";

/** How long a same-device verification's id waits for the return: the verifier's own 15 minutes. */
export const DEFAULT_RETURN_TTL_MS = 15 * 60 * 1000;

function defaultStorage(): Storage {
  try {
    return localStorage;
  } catch {
    return sessionStorage;
  }
}

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

function describe(error: unknown): string {
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  return name.length > 0 ? `${name}: ${message}` : message;
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
    const prompted = await browserPrompt(options, detection);
    if (prompted.outcome !== "fallback") return prompted;
    flow = fallback;
  }

  options.onFlow?.(flow);
  if (flow === "same_device") return sameDevice(options);
  return crossDevice(options);
}

type PromptOutcome = VerifyResult | { outcome: "fallback" };

/**
 * What a `dc_api` start tells the customer's server: the prompt protocols
 * this browser allows, in the order to offer them, and the page's origin,
 * which the ISO mdoc protocol's request is made for. A page that starts
 * ahead of the tap passes this to `transport.start`; the element does.
 */
export function promptStartOptions(detection: Pick<Detection, "protocols">): StartOptions {
  // A browser that allows none asks for nothing: the server offers what it
  // offers, and the start's requests are then checked against the browser.
  const options: StartOptions = detection.protocols.length === 0 ? {} : { dcApiProtocols: [...detection.protocols] };
  const origin = pageOrigin();
  if (origin !== undefined) options.dcApiOrigin = origin;
  return options;
}

function pageOrigin(): string | undefined {
  try {
    const origin = location.origin;
    return typeof origin === "string" && origin !== "null" && origin.length > 0 ? origin : undefined;
  } catch {
    return undefined;
  }
}

async function startOf(options: VerifyOptions, flow: Flow, startOptions?: StartOptions): Promise<PageStart> {
  const prepared = options.prepared === undefined ? undefined : await options.prepared;
  return prepared !== undefined && prepared.flow === flow ? prepared : options.transport.start(flow, startOptions);
}

/** The protocol of one entry of `dcApiRequests`, or undefined. */
function protocolOf(request: unknown): string | undefined {
  const protocol =
    request !== null && typeof request === "object" ? (request as { protocol?: unknown }).protocol : undefined;
  return typeof protocol === "string" ? protocol : undefined;
}

async function browserPrompt(options: VerifyOptions, detection: Detection): Promise<PromptOutcome> {
  let start: PageStart;
  try {
    start = await startOf(options, "dc_api", promptStartOptions(detection));
  } catch (error) {
    // The customer's server, or the verifier behind it, refused a prompt start:
    // the page's origin is not registered, say. The next way may still work.
    if (error instanceof TransportError && error.status >= 400 && error.status < 500) {
      options.onFallback?.(`The server refused a browser-prompt start: ${error.message}`);
      return { outcome: "fallback" };
    }
    throw error;
  }
  if (!Array.isArray(start.dcApiRequests) || typeof start.dcApiResponseUrl !== "string") {
    options.onFallback?.("The start carried no browser-prompt request.");
    return { outcome: "fallback" };
  }
  // The server offers what it can; a start whose every request is in a
  // protocol this browser lacks (Safari, for a credential that is not an
  // mdoc) would only fail in the prompt. The next way may still work.
  if (!start.dcApiRequests.some((request) => detection.protocols.includes(protocolOf(request) ?? ""))) {
    options.onFallback?.("The start offered no browser-prompt protocol this browser allows.");
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
      return {
        outcome: "cancelled",
        id: start.id,
        flow: "dc_api",
        fallback: detect().phone ? "same_device" : "cross_device",
        reason: describe(error),
      };
    }
    // The browser cannot do it after all (no protocol, no support): try the next way.
    options.onFallback?.(`The browser could not run the prompt: ${describe(error)}`);
    return { outcome: "fallback" };
  }
  if (credential === null || typeof credential !== "object" || typeof credential.protocol !== "string") {
    options.onFallback?.("The browser answered with no credential.");
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
  if (response.ok) {
    // The relay told the page; now the customer's server reads the result
    // itself, with its key, which is what it must act on. Its answer is the
    // page's outcome; the relay's word stands if that read fails.
    try {
      const { status } = await options.transport.status(start.id);
      if (isFinal(status)) return { outcome: status, id: start.id, flow: "dc_api" };
    } catch {
      // The relay's verdict stands.
    }
    return { outcome: "verified", id: start.id, flow: "dc_api" };
  }
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
  const start = await startOf(options, "same_device");
  if (typeof start.authorizationRequestUri !== "string") {
    return { outcome: "failed", id: start.id, flow: "same_device", reason: "The start carried no link." };
  }
  const storage = options.storage ?? defaultStorage();
  storage.setItem(options.storageKey ?? DEFAULT_STORAGE_KEY, JSON.stringify({ id: start.id, at: Date.now() }));
  const navigate = options.navigate ?? ((url: string) => location.assign(url));
  if (options.onReturn !== undefined) listenForReturn(options, start.id, options.onReturn);
  navigate(start.authorizationRequestUri);
  return { outcome: "redirected", id: start.id, flow: "same_device" };
}

/** Waits, for as long as the verifier keeps the verification, for the return tab's announcement of this id. */
function listenForReturn(
  options: VerifyOptions,
  id: string,
  onReturn: (result: { outcome: VerificationStatus; id: string }) => void,
): void {
  const target = options.windowObject ?? window;
  const resultKey = `${options.storageKey ?? DEFAULT_STORAGE_KEY}:result`;
  const stop = () => {
    clearTimeout(timer);
    target.removeEventListener("storage", onStorage);
  };
  const onStorage = (event: Event) => {
    const { key, newValue } = event as StorageEvent;
    if (key !== resultKey || typeof newValue !== "string") return;
    try {
      const parsed = JSON.parse(newValue) as { id?: unknown; outcome?: unknown };
      if (parsed.id === id && typeof parsed.outcome === "string") {
        stop();
        onReturn({ outcome: parsed.outcome as VerificationStatus, id });
      }
    } catch {
      // Not ours.
    }
  };
  const timer = setTimeout(stop, DEFAULT_RETURN_TTL_MS);
  target.addEventListener("storage", onStorage);
}

async function crossDevice(options: VerifyOptions): Promise<VerifyResult> {
  const start = await startOf(options, "cross_device");
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
  /** Where `verify` kept the id; `localStorage` by default. */
  storage?: Storage;
  storageKey?: string;
  /** An id kept longer ago than this is ignored, as the verifier has expired it anyway. */
  returnTtlMs?: number;
  /** Removes the code from the address bar; `history.replaceState` by default. */
  replaceUrl?: (url: string) => void;
}

export type CompleteResult =
  | { outcome: "verified" | "failed" | "expired" | "pending" | "awaiting_return"; id: string }
  /** The URL carries no `response_code`: this is not a return from the wallet. */
  | { outcome: "no_code" }
  /** A code arrived, but this browser started no verification lately: nothing is exchanged, nothing is shown (HAIP §5.1). */
  | { outcome: "no_session" };

/**
 * On the return page: finishes a same-device verification. The id comes from
 * this browser's own storage for the page's origin, never from the URL, and
 * the customer's server exchanges the code with it. A browser that arrives
 * with a code but started nothing gets nothing.
 */
export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const href = options.url ?? location.href;
  const url = new URL(href);
  const code = url.searchParams.get("response_code");
  if (code === null || code.length === 0) return { outcome: "no_code" };
  const storage = options.storage ?? defaultStorage();
  const key = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const kept = storage.getItem(key);
  const ttl = options.returnTtlMs ?? DEFAULT_RETURN_TTL_MS;
  let id: string | undefined;
  if (kept !== null) {
    try {
      const parsed = JSON.parse(kept) as { id?: unknown; at?: unknown };
      const fresh = typeof parsed.at === "number" && Date.now() - parsed.at <= ttl;
      if (typeof parsed.id === "string" && fresh) id = parsed.id;
    } catch {
      id = undefined;
    }
    if (id === undefined) storage.removeItem(key);
  }
  url.searchParams.delete("response_code");
  const replace = options.replaceUrl ?? ((next: string) => history.replaceState(history.state, "", next));
  replace(url.toString());
  if (id === undefined) return { outcome: "no_session" };
  storage.removeItem(key);
  const { status } = await options.transport.exchange(id, code);
  // Tell the tab that opened the wallet, if it is still open: a change to the
  // origin's storage reaches every other tab of this browser.
  try {
    storage.setItem(`${key}:result`, JSON.stringify({ id, outcome: status, at: Date.now() }));
  } catch {
    // Storage full or refused: the return tab still has its result.
  }
  return { outcome: status, id };
}
