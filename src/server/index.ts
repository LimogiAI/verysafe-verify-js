// The server half: runs on the customer's server, with the key, for Node.
export {
  type ClientOptions,
  createClient,
  type CredentialTypeSummary,
  type StartedVerification,
  type StartInput,
  type Verification,
  VerySafeApiError,
  VerySafeClient,
} from "./client.js";
export { handleNodeRequest, MAX_PAGE_BODY_BYTES, readJsonBody } from "./node.js";
export { handlePageRequest, type PageContext, type PageHandlerOptions, type PageHandlerResult } from "./page.js";
export {
  DC_API_PROTOCOLS,
  type DcApiProtocol,
  FINAL_STATUSES,
  type Flow,
  isDcApiProtocol,
  FLOWS,
  isFinal,
  isFlow,
  type PageError,
  type PageReply,
  type PageRequest,
  type PageStart,
  type PageStatus,
  type VerificationStatus,
} from "../shared/types.js";
export { VERSION } from "../version.js";
