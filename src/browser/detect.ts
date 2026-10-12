import type { Flow } from "../shared/types.js";

/** The browser-prompt protocol the verifier speaks today (OpenID4VP 1.0 Appendix A, signed). */
export const DEFAULT_PROTOCOLS: readonly string[] = ["openid4vp-v1-signed"];

export interface Detection {
  /** The browser offers the W3C Digital Credentials API. */
  digitalCredentials: boolean;
  /** Of the protocols asked about, those the browser says it allows. Empty without the API. */
  protocols: string[];
  /** The page is on a phone, so a link can open the wallet on the same device. */
  phone: boolean;
  /** The way to try first: the prompt where it exists, else a link on a phone, else a QR code. */
  flow: Flow;
}

export interface DetectOptions {
  /** The browser-prompt protocols to ask the browser about. Defaults to the one the verifier speaks. */
  protocols?: readonly string[];
  /** The global object to inspect; `globalThis` by default. For tests. */
  globalObject?: object;
  /** Overrides the browser's user agent string. For tests. */
  userAgent?: string;
}

interface GlobalLike {
  DigitalCredential?: { userAgentAllowsProtocol?: (protocol: string) => boolean };
  navigator?: {
    credentials?: { get?: unknown };
    userAgent?: string;
    userAgentData?: { mobile?: boolean };
  };
}

/**
 * What this browser can do, and so which way to try first. The W3C API's own
 * check, `DigitalCredential.userAgentAllowsProtocol`, decides the protocols
 * where the browser implements it; a browser that has the API but not the
 * check is taken to allow every protocol asked about, and a wrong guess is
 * caught when the prompt refuses and the library falls back.
 */
export function detect(options: DetectOptions = {}): Detection {
  const g = (options.globalObject ?? globalThis) as GlobalLike;
  const requested = [...(options.protocols ?? DEFAULT_PROTOCOLS)];
  const dc = g.DigitalCredential;
  const api = dc !== undefined && typeof g.navigator?.credentials?.get === "function";
  let protocols: string[] = [];
  if (api) {
    const allows =
      typeof dc.userAgentAllowsProtocol === "function"
        ? (protocol: string) => {
            try {
              return dc.userAgentAllowsProtocol?.(protocol) === true;
            } catch {
              return false;
            }
          }
        : () => true;
    protocols = requested.filter(allows);
  }
  const userAgent = options.userAgent ?? g.navigator?.userAgent ?? "";
  const phone = g.navigator?.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const flow: Flow = api && protocols.length > 0 ? "dc_api" : phone ? "same_device" : "cross_device";
  return { digitalCredentials: api, protocols, phone, flow };
}
