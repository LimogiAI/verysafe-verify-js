import type { Flow, VerificationStatus } from "../shared/types.js";
import { VERSION } from "../version.js";

export interface ClientOptions {
  /** The verifier: `https://verify.verysafe.id`, `https://sandbox.verysafe.id`, or a self-hosted installation. */
  baseUrl: string;
  /** The API key. It stays on the server; this package never sends it anywhere but `baseUrl`. */
  apiKey: string;
  /** The fetch to use; Node's by default. For tests. */
  fetch?: typeof fetch;
  /** Extra headers on every call. */
  headers?: Record<string, string>;
}

/** What a start asks for: the verifier's `POST /v1/verifications` body. */
export interface StartInput {
  flow: Flow;
  /** Required with `same_device`: the page the wallet sends the person back to, on an origin registered for the key. */
  returnUrl?: string;
  /** What the link starts with: `openid4vp://` (the default), `haip-vp://`, `eu-eaap://`, or a wallet's https app link. Not with `dc_api`. */
  linkScheme?: string;
  /** One of the verifier's credential types; `eu_pid` by default. */
  credentialType?: string;
  /** The claims to ask for; the type's defaults otherwise. Ask for the fewest that answer the question. */
  claims?: string[];
  /** The customer's own reference, echoed with the result. Never personal data. */
  reference?: string;
  /** Up to ten more values of the customer's own, echoed with the result. */
  metadata?: Record<string, string>;
  /** The registered intended use this check is for, where the key belongs to a Service with registered uses. */
  intendedUse?: string;
}

/** The verifier's answer to a start. Nothing in it is a claim. */
export interface StartedVerification {
  id: string;
  status: VerificationStatus;
  flow: Flow;
  credentialType?: string;
  requestedClaims?: string[];
  authorizationRequestUri?: string;
  dcApiRequests?: unknown[];
  dcApiResponseUrl?: string;
  pollUrl?: string;
  reference?: string;
  metadata?: Record<string, string>;
  intendedUse?: string;
}

/** A verification as `GET /v1/verifications/{id}` and the exchange return it. `result` holds the claims once verified. */
export interface Verification {
  id: string;
  status: VerificationStatus;
  flow: Flow;
  createdAt?: string;
  reference?: string;
  metadata?: Record<string, string>;
  result?: Record<string, unknown> | null;
}

/** The verifier answered with an error. `status` is its HTTP status; `error` its message. */
export class VerySafeApiError extends Error {
  readonly status: number;
  readonly error: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly body: unknown;

  constructor(status: number, body: unknown, retryAfterSeconds?: number) {
    const error =
      body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : undefined;
    super(error ?? `The verifier answered ${status}.`);
    this.name = "VerySafeApiError";
    this.status = status;
    this.error = error;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`baseUrl is not a URL: "${value}".`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.host.replace(/:\d+$/, "")))) {
    throw new TypeError("baseUrl must be https, or http on this machine only.");
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new TypeError("baseUrl is an origin and a path only.");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Calls the verifier with the key. One per key; share it across requests. */
export class VerySafeClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: ClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) throw new TypeError("apiKey is required.");
    this.baseUrl = checkBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#headers = options.headers ?? {};
  }

  /** `POST /v1/verifications`. */
  start(input: StartInput): Promise<StartedVerification> {
    return this.#request<StartedVerification>("POST", "/v1/verifications", input);
  }

  /** `GET /v1/verifications/{id}`. The claims are in `result` once the status is `verified`. */
  read(id: string): Promise<Verification> {
    return this.#request<Verification>("GET", `/v1/verifications/${encodeId(id)}`);
  }

  /** `POST /v1/verifications/{id}/exchange`: releases a same-device result with the code the person came back with. */
  exchange(id: string, responseCode: string): Promise<Verification> {
    if (typeof responseCode !== "string" || responseCode.length === 0) throw new TypeError("responseCode is required.");
    return this.#request<Verification>("POST", `/v1/verifications/${encodeId(id)}/exchange`, { responseCode });
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        ...this.#headers,
        "x-api-key": this.#apiKey,
        accept: "application/json",
        "user-agent": `verysafe-verify/${VERSION}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.#fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown ;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      throw new VerySafeApiError(response.status, parsed, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    if (parsed === null || typeof parsed !== "object") throw new VerySafeApiError(response.status, parsed);
    return parsed as T;
  }
}

function encodeId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new TypeError("id is required.");
  return encodeURIComponent(id);
}

export function createClient(options: ClientOptions): VerySafeClient {
  return new VerySafeClient(options);
}
