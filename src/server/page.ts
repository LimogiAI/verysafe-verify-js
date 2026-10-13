import {
  DC_API_PROTOCOLS,
  type DcApiProtocol,
  type Flow,
  FLOWS,
  isDcApiProtocol,
  isFlow,
  type PageReply,
  type PageStart,
  type PageStatus,
} from "../shared/types.js";
import type { StartedVerification, StartInput, Verification, VerySafeClient } from "./client.js";
import { VerySafeApiError } from "./client.js";

export interface PageHandlerOptions {
  /** The return page for `same_device`, or a function of the flow. Without it, a same-device start is refused. */
  returnUrl?: string | ((flow: Flow) => string | undefined);
  /**
   * What every start carries besides `flow`, or a function of the flow.
   * `linkScheme` is dropped for `dc_api`. Its `dcApiProtocols` is the most a
   * page may be offered: the page asks for the protocols its browser allows,
   * and gets those among them. Its `dcApiOrigin`, when set, wins over the
   * request's own origin.
   */
  start?: Partial<Omit<StartInput, "flow">> | ((flow: Flow) => Partial<Omit<StartInput, "flow">>);
  /** The flows the page may ask for; all three by default. */
  allowFlows?: readonly Flow[];
  /** Whether this browser session may ask about this verification. For a server that keeps ids per session. */
  ownsVerification?: (id: string) => boolean | Promise<boolean>;
  /** Called with errors from the verifier that the page is not told about in full. */
  onError?: (error: unknown) => void;
}

/** What the server knows about the page's request beyond its body. */
export interface PageContext {
  /** The request's `Origin` header: the page's origin as the browser asserts it. `handleNodeRequest` passes it. */
  origin?: string | undefined;
}

export interface PageHandlerResult {
  /** The HTTP status to answer the page with. */
  status: number;
  /** The body to answer the page with. Never a claim. */
  reply: PageReply;
  /** On `status` and `exchange`: the whole verification, claims included, for the server's own use. */
  verification?: Verification;
  /** On `start`: the verifier's whole answer. */
  started?: StartedVerification;
}

const PAGE_START_FIELDS = [
  "id",
  "flow",
  "status",
  "authorizationRequestUri",
  "dcApiRequests",
  "dcApiResponseUrl",
] as const;

function toPageStart(started: StartedVerification): PageStart {
  const out: Record<string, unknown> = {};
  for (const field of PAGE_START_FIELDS) if (started[field] !== undefined) out[field] = started[field];
  return out as unknown as PageStart;
}

function toPageStatus(verification: Verification): PageStatus {
  return { id: verification.id, status: verification.status };
}

function refused(status: number, error: string): PageHandlerResult {
  return { status, reply: { error } };
}

const PASSED_THROUGH = new Set([400, 404, 409, 413, 429]);

/**
 * Answers one of the page's three calls, `start`, `status` or `exchange`,
 * with the key, and gives the page a status and never a claim. The claims
 * come back to the caller in `verification`, for the server to act on.
 */
export async function handlePageRequest(
  client: VerySafeClient,
  body: unknown,
  options: PageHandlerOptions = {},
  context: PageContext = {},
): Promise<PageHandlerResult> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return refused(400, 'Post a JSON object with an "action".');
  }
  const request = body as Record<string, unknown>;
  try {
    switch (request.action) {
      case "start":
        return await start(client, request, options, context);
      case "status":
      case "exchange":
        return await readOrExchange(client, request, options);
      default:
        return refused(400, '"action" must be "start", "status" or "exchange".');
    }
  } catch (error) {
    options.onError?.(error);
    if (error instanceof VerySafeApiError) {
      if (PASSED_THROUGH.has(error.status)) {
        return { status: error.status, reply: { error: error.error ?? `The verifier answered ${error.status}.` } };
      }
      if (error.status === 401 || error.status === 403) return refused(502, "The verifier refused this server's key.");
    }
    return refused(502, "The verifier could not be reached.");
  }
}

/** The verifier's format of an mdoc credential type. */
const MDOC_FORMAT = "mso_mdoc";

/** An origin as a browser serialises it, https, or http on this machine only. */
function isPageOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.origin === value && (url.protocol === "https:" || local);
  } catch {
    return false;
  }
}

/**
 * Which prompt protocols this start offers (`dcApiProtocols`), and for which
 * page (`dcApiOrigin`): what the page asked for, narrowed to what the
 * server's `start` option allows, and to what the credential asked for can
 * answer: the ISO mdoc protocol needs an mdoc, which `GET
 * /v1/credential-types` says. Or why the start is refused.
 */
async function offerProtocols(
  client: VerySafeClient,
  request: Record<string, unknown>,
  input: StartInput,
  context: PageContext,
): Promise<PageHandlerResult | undefined> {
  const asked = request.dcApiProtocols;
  if (asked !== undefined) {
    if (
      !Array.isArray(asked) ||
      asked.length === 0 ||
      !asked.every(isDcApiProtocol) ||
      new Set(asked).size !== asked.length
    ) {
      return refused(
        400,
        `"dcApiProtocols" lists ${DC_API_PROTOCOLS.map((p) => `"${p}"`).join(" and/or ")}, each once.`,
      );
    }
  }
  const allowed = input.dcApiProtocols;
  let offered: DcApiProtocol[] | undefined =
    asked === undefined
      ? allowed
      : allowed === undefined
        ? (asked as DcApiProtocol[])
        : (asked as DcApiProtocol[]).filter((p) => allowed.includes(p));
  if (offered !== undefined && offered.length === 0) {
    return refused(400, "This server offers none of the browser-prompt protocols the page asked for.");
  }
  if (offered?.includes("org-iso-mdoc")) {
    // The verifier's default credential type is the PID as an SD-JWT VC, which
    // the ISO mdoc protocol cannot ask for. A named type is looked up; one
    // the verifier does not list, or a lookup that fails, leaves the offer to
    // the verifier's own refusal.
    let mdoc = false;
    if (input.credentialType !== undefined) {
      try {
        const types = await client.credentialTypes();
        const type = types.find((t) => t.id === input.credentialType);
        mdoc = type === undefined || type.format === MDOC_FORMAT;
      } catch {
        mdoc = true;
      }
    }
    if (!mdoc) offered = offered.filter((p) => p !== "org-iso-mdoc");
    if (offered.length === 0) {
      return refused(
        400,
        "This browser's only prompt protocol asks for an mdoc, and the credential asked for here is not one.",
      );
    }
  }
  if (offered === undefined) delete input.dcApiProtocols;
  else input.dcApiProtocols = offered;

  if (offered?.includes("org-iso-mdoc")) {
    const origin = input.dcApiOrigin ?? context.origin ?? request.dcApiOrigin;
    if (origin === undefined) {
      // The verifier takes the one registered origin, or says which to name.
      delete input.dcApiOrigin;
    } else if (!isPageOrigin(origin)) {
      return refused(400, '"dcApiOrigin" must be the page\'s origin, such as https://shop.example.');
    } else {
      input.dcApiOrigin = origin;
    }
  } else {
    delete input.dcApiOrigin;
  }
  return undefined;
}

async function start(
  client: VerySafeClient,
  request: Record<string, unknown>,
  options: PageHandlerOptions,
  context: PageContext,
): Promise<PageHandlerResult> {
  const flow = request.flow;
  if (!isFlow(flow)) return refused(400, `"flow" must be one of ${FLOWS.join(", ")}.`);
  if (!(options.allowFlows ?? FLOWS).includes(flow)) return refused(400, `The flow "${flow}" is not offered here.`);
  const base = typeof options.start === "function" ? options.start(flow) : (options.start ?? {});
  const input: StartInput = { ...base, flow };
  if (flow === "dc_api") {
    delete input.linkScheme;
    const problem = await offerProtocols(client, request, input, context);
    if (problem !== undefined) return problem;
  } else {
    delete input.dcApiProtocols;
    delete input.dcApiOrigin;
  }
  if (flow === "same_device") {
    const returnUrl = typeof options.returnUrl === "function" ? options.returnUrl(flow) : options.returnUrl;
    if (typeof returnUrl !== "string" || returnUrl.length === 0) {
      return refused(400, "A same-device start needs a return page, and this server has none.");
    }
    input.returnUrl = returnUrl;
  } else {
    delete input.returnUrl;
  }
  const started = await client.start(input);
  return { status: 201, reply: toPageStart(started), started };
}

async function readOrExchange(
  client: VerySafeClient,
  request: Record<string, unknown>,
  options: PageHandlerOptions,
): Promise<PageHandlerResult> {
  const id = request.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return refused(400, '"id" is required.');
  if (options.ownsVerification !== undefined && !(await options.ownsVerification(id))) {
    return refused(404, "No such verification in this session.");
  }
  let verification: Verification;
  if (request.action === "exchange") {
    const code = request.responseCode;
    if (typeof code !== "string" || code.length === 0 || code.length > 512)
      return refused(400, '"responseCode" is required.');
    verification = await client.exchange(id, code);
  } else {
    verification = await client.read(id);
  }
  return { status: 200, reply: toPageStatus(verification), verification };
}
