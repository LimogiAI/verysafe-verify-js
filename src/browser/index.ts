// The browser half: what a customer's page includes. It never holds the key.
export { DEFAULT_PROTOCOLS, detect, type DetectOptions, type Detection } from "./detect.js";
export { DEFAULT_PREPARE_TTL_MS, defineElement, VerySafeVerifyElement } from "./element.js";
export { qrPath, qrSvg, type QrSvgOptions } from "./qr.js";
export { httpTransport, type HttpTransportOptions, type Transport, TransportError } from "./transport.js";
export {
  complete,
  type CompleteOptions,
  type CompleteResult,
  DEFAULT_RESULT_KEY,
  DEFAULT_RETURN_TTL_MS,
  DEFAULT_STORAGE_KEY,
  verify,
  type VerifyOptions,
  type VerifyResult,
} from "./verify.js";
export { FLOWS, type Flow, isFlow, type PageStart, type PageStatus, type VerificationStatus } from "../shared/types.js";
export { VERSION } from "../version.js";
