// The shapes the browser half and the server half share. They mirror the
// verifier's public API (GET /openapi.json on the service) where the page
// needs them, and nothing else: no claim ever appears here, and no key.

/** How the person presents: the verifier's `flow`. */
export type Flow = "dc_api" | "same_device" | "cross_device";

export const FLOWS: readonly Flow[] = ["dc_api", "same_device", "cross_device"];

export function isFlow(value: unknown): value is Flow {
  return typeof value === "string" && (FLOWS as readonly string[]).includes(value);
}

/**
 * The browser prompt's protocols the verifier speaks: OpenID4VP's signed
 * request, which Chrome and the EU wallets answer, and the ISO mdoc protocol
 * of ISO/IEC 18013-7 Annex C, the only one Safari has, which asks for an mdoc.
 */
export type DcApiProtocol = "openid4vp-v1-signed" | "org-iso-mdoc";

export const DC_API_PROTOCOLS: readonly DcApiProtocol[] = ["openid4vp-v1-signed", "org-iso-mdoc"];

export function isDcApiProtocol(value: unknown): value is DcApiProtocol {
  return typeof value === "string" && (DC_API_PROTOCOLS as readonly string[]).includes(value);
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
  /** `dc_api` only: what the page passes to `navigator.credentials.get`, one entry per protocol offered, in order. */
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
  | {
      action: "start";
      flow: Flow;
      /** `dc_api`: the prompt protocols this browser allows, in the order to offer them. The server forwards what it offers. */
      dcApiProtocols?: DcApiProtocol[];
      /** `dc_api`: the page's origin, which the ISO mdoc protocol's request is made for. The server prefers the request's own `Origin` header. */
      dcApiOrigin?: string;
    }
  | { action: "status"; id: string }
  | { action: "exchange"; id: string; responseCode: string };

export interface PageError {
  error: string;
}

export type PageReply = PageStart | PageStatus | PageError;
