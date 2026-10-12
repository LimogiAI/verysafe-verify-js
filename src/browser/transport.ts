import type { Flow, PageReply, PageStart, PageStatus } from "../shared/types.js";

/**
 * The three calls the page makes to the customer's server. The server half of
 * this package answers them (`handlePageRequest`); a server on another
 * platform implements the same three.
 */
export interface Transport {
  start(flow: Flow): Promise<PageStart>;
  status(id: string): Promise<PageStatus>;
  exchange(id: string, responseCode: string): Promise<PageStatus>;
}

/** The customer's server, or the verifier's relay, answered with an error. */
export class TransportError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = "TransportError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface HttpTransportOptions {
  /** Extra request headers, such as a CSRF token the customer's server expects. */
  headers?: Record<string, string>;
  /** Whether the browser sends the page's cookies; `same-origin` by default. */
  credentials?: RequestCredentials;
  /** The fetch to use; the browser's by default. For tests. */
  fetch?: typeof fetch;
}

/**
 * A transport that posts each call as JSON to one endpoint on the customer's
 * server: `{"action": "start", "flow": …}`, `{"action": "status", "id": …}`,
 * `{"action": "exchange", "id": …, "responseCode": …}`. The server half's
 * `handlePageRequest` reads exactly these.
 */
export function httpTransport(endpoint: string, options: HttpTransportOptions = {}): Transport {
  const doFetch = options.fetch ?? fetch;
  async function post<T extends PageReply>(body: object): Promise<T> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(options.headers ?? {}) },
      credentials: options.credentials ?? "same-origin",
      body: JSON.stringify(body),
    });
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
      const error =
        parsed !== null && typeof parsed === "object" && typeof (parsed as PageReply & { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `The server answered ${response.status}.`;
      const retry = Number(response.headers.get("retry-after"));
      throw new TransportError(error, response.status, parsed, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new TransportError("The server answered with no JSON object.", response.status, parsed);
    }
    return parsed as T;
  }
  return {
    start: (flow) => post<PageStart>({ action: "start", flow }),
    status: (id) => post<PageStatus>({ action: "status", id }),
    exchange: (id, responseCode) => post<PageStatus>({ action: "exchange", id, responseCode }),
  };
}
