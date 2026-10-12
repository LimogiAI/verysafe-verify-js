// The shapes the browser half and the server half share. They mirror the
// verifier's public API (GET /openapi.json on the service) where the page
// needs them, and nothing else: no claim ever appears here, and no key.

/** How the person presents: the verifier's `flow`. */
export type Flow = "dc_api" | "same_device" | "cross_device";

export const FLOWS: readonly Flow[] = ["dc_api", "same_device", "cross_device"];

export function isFlow(value: unknown): value is Flow {
  return typeof value === "string" && (FLOWS as readonly string[]).includes(value);
}

/** A verification's status, as the verifier reports it. */
export type VerificationStatus = "pending" | "awaiting_return" | "verified" | "failed" | "expired";

/** The statuses after which nothing changes. */
export const FINAL_STATUSES: readonly VerificationStatus[] = ["verified", "failed", "expired"];

export function isFinal(status: string): status is "verified" | "failed" | "expired" {
  return (FINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * What the page receives from the customer's server after a start. It is the
 * verifier's answer to `POST /v1/verifications` reduced to what the page needs:
 * never a claim, never a key.
 */
export interface PageStart {
  id: string;
  flow: Flow;
  status: VerificationStatus;
  /** Every flow but `dc_api`: the link the wallet opens, or the QR code's content. */
  authorizationRequestUri?: string;
  /** `dc_api` only: what the page passes to `navigator.credentials.get`. */
  dcApiRequests?: unknown[];
  /** `dc_api` only: where the page posts the browser's answer, unopened and with no key. */
  dcApiResponseUrl?: string;
}

/** What the page receives when it asks how a verification stands: a status, never a claim. */
export interface PageStatus {
  id: string;
  status: VerificationStatus;
}

/** The three calls between the page and the customer's server. */
export type PageRequest =
  | { action: "start"; flow: Flow }
  | { action: "status"; id: string }
  | { action: "exchange"; id: string; responseCode: string };

export interface PageError {
  error: string;
}

export type PageReply = PageStart | PageStatus | PageError;
