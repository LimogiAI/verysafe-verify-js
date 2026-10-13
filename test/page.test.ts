import { describe, expect, it, vi } from "vitest";
import { createClient, VerySafeApiError } from "../src/server/client.js";
import { handlePageRequest } from "../src/server/page.js";

function clientWith(answers: Record<string, unknown>) {
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const answer = answers[key];
    if (answer instanceof VerySafeApiError)
      return new Response(JSON.stringify({ error: answer.error }), {
        status: answer.status,
        headers: answer.retryAfterSeconds ? { "retry-after": String(answer.retryAfterSeconds) } : {},
      });
    if (answer === undefined) return new Response(JSON.stringify({ error: `unexpected ${key}` }), { status: 500 });
    return new Response(JSON.stringify(answer), {
      status: init.method === "POST" && !url.endsWith("/exchange") ? 201 : 200,
    });
  });
  return {
    client: createClient({ baseUrl: "https://verify.example", apiKey: "secret", fetch: f as unknown as typeof fetch }),
    f,
  };
}

const STARTED = {
  id: "v1",
  status: "pending",
  flow: "dc_api",
  credentialType: "eu_pid",
  requestedClaims: ["given_name"],
  dcApiRequests: [{ protocol: "openid4vp-v1-signed", data: {} }],
  dcApiResponseUrl: "https://verify.example/v1/verifications/v1/dc-api-response",
  pollUrl: "https://verify.example/v1/verifications/v1",
  reference: "order-1",
};

const TYPES = {
  credentialTypes: [
    { id: "eu_pid", format: "dc+sd-jwt" },
    { id: "eu_pid_mdoc", format: "mso_mdoc" },
    { id: "iso_mdl", format: "mso_mdoc" },
  ],
};
const ISO_STARTED = {
  ...STARTED,
  credentialType: "eu_pid_mdoc",
  dcApiRequests: [
    { protocol: "org-iso-mdoc", data: {} },
    { protocol: "openid4vp-v1-signed", data: {} },
  ],
};
const sentBody = (f: ReturnType<typeof vi.fn>, n = 0) =>
  JSON.parse(String((f.mock.calls[n] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
const verifierCalls = (f: ReturnType<typeof vi.fn>) =>
  (f.mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => `${init.method} ${new URL(url).pathname}`);

describe("handlePageRequest: which prompt protocols a page is offered (J5)", () => {
  it("forwards what the page's browser allows, in its order, for an mdoc, with the page's origin from the request's Origin header", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": ISO_STARTED, "GET /v1/credential-types": TYPES });
    const result = await handlePageRequest(
      client,
      {
        action: "start",
        flow: "dc_api",
        dcApiProtocols: ["org-iso-mdoc", "openid4vp-v1-signed"],
        dcApiOrigin: "https://claimed.example",
      },
      { start: { credentialType: "eu_pid_mdoc" } },
      { origin: "https://shop.example" },
    );
    expect(result.status).toBe(201);
    expect((result.reply as { dcApiRequests: unknown[] }).dcApiRequests).toHaveLength(2);
    expect(verifierCalls(f)).toEqual(["GET /v1/credential-types", "POST /v1/verifications"]);
    expect(sentBody(f, 1)).toEqual({
      flow: "dc_api",
      credentialType: "eu_pid_mdoc",
      dcApiProtocols: ["org-iso-mdoc", "openid4vp-v1-signed"],
      dcApiOrigin: "https://shop.example",
    });
  });

  it("takes the page's own word for its origin without an Origin header, refuses one that is not an origin, and lets the verifier choose when there is none", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": ISO_STARTED, "GET /v1/credential-types": TYPES });
    const options = { start: { credentialType: "iso_mdl" as const } };
    expect(
      (
        await handlePageRequest(
          client,
          { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"], dcApiOrigin: "https://shop.example" },
          options,
        )
      ).status,
    ).toBe(201);
    expect(sentBody(f, 1).dcApiOrigin).toBe("https://shop.example");
    expect(
      (await handlePageRequest(client, { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"] }, options))
        .status,
    ).toBe(201);
    expect(sentBody(f, 2)).not.toHaveProperty("dcApiOrigin");
    for (const bad of ["https://shop.example/", "shop.example", "http://shop.example", 7, "null"]) {
      const refused = await handlePageRequest(
        client,
        { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"], dcApiOrigin: bad },
        options,
      );
      expect(refused.status).toBe(400);
      expect((refused.reply as { error: string }).error).toBe(
        '"dcApiOrigin" must be the page\'s origin, such as https://shop.example.',
      );
    }
    expect(
      (
        await handlePageRequest(
          client,
          { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"] },
          { start: { credentialType: "iso_mdl", dcApiOrigin: "https://fixed.example" } },
          { origin: "https://shop.example" },
        )
      ).status,
    ).toBe(201);
    expect(sentBody(f, 3).dcApiOrigin).toBe("https://fixed.example");
    // The types were read once for the client.
    expect(verifierCalls(f).filter((c) => c === "GET /v1/credential-types")).toHaveLength(1);
  });

  it("narrows the page's ask to what the server offers, in the page's order, and refuses a page it can offer nothing", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": STARTED, "GET /v1/credential-types": TYPES });
    const options = {
      start: { credentialType: "eu_pid_mdoc" as const, dcApiProtocols: ["openid4vp-v1-signed" as const] },
    };
    expect(
      (
        await handlePageRequest(
          client,
          {
            action: "start",
            flow: "dc_api",
            dcApiProtocols: ["org-iso-mdoc", "openid4vp-v1-signed"],
            dcApiOrigin: "https://shop.example",
          },
          options,
        )
      ).status,
    ).toBe(201);
    expect(sentBody(f, 0)).toEqual({
      flow: "dc_api",
      credentialType: "eu_pid_mdoc",
      dcApiProtocols: ["openid4vp-v1-signed"],
    });
    const refused = await handlePageRequest(
      client,
      { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"] },
      options,
    );
    expect(refused.status).toBe(400);
    expect((refused.reply as { error: string }).error).toBe(
      "This server offers none of the browser-prompt protocols the page asked for.",
    );
    // The server's own offer stands when the page asks nothing.
    expect((await handlePageRequest(client, { action: "start", flow: "dc_api" }, options)).status).toBe(201);
    expect(sentBody(f, 1).dcApiProtocols).toEqual(["openid4vp-v1-signed"]);
  });

  it("keeps the ISO mdoc protocol for an mdoc only: the verifier's default type and an SD-JWT VC lose it, and Safari's only protocol is refused for them", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": STARTED, "GET /v1/credential-types": TYPES });
    expect(
      (
        await handlePageRequest(client, {
          action: "start",
          flow: "dc_api",
          dcApiProtocols: ["openid4vp-v1-signed", "org-iso-mdoc"],
          dcApiOrigin: "https://shop.example",
        })
      ).status,
    ).toBe(201);
    expect(sentBody(f, 0)).toEqual({ flow: "dc_api", dcApiProtocols: ["openid4vp-v1-signed"] });
    expect(
      (
        await handlePageRequest(
          client,
          { action: "start", flow: "dc_api", dcApiProtocols: ["openid4vp-v1-signed", "org-iso-mdoc"] },
          { start: { credentialType: "eu_pid" } },
        )
      ).status,
    ).toBe(201);
    expect(sentBody(f, 2).dcApiProtocols).toEqual(["openid4vp-v1-signed"]);
    const refused = await handlePageRequest(
      client,
      { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"] },
      { start: { credentialType: "eu_pid" } },
    );
    expect(refused.status).toBe(400);
    expect((refused.reply as { error: string }).error).toBe(
      "This browser's only prompt protocol asks for an mdoc, and the credential asked for here is not one.",
    );
    // The default type is never looked up; a named one, once.
    expect(verifierCalls(f).filter((c) => c === "GET /v1/credential-types")).toHaveLength(1);
  });

  it("leaves the ISO mdoc protocol in when the types cannot be read, and the verifier decides; the next start reads again", async () => {
    const { client, f } = clientWith({
      "POST /v1/verifications": ISO_STARTED,
      "GET /v1/credential-types": new VerySafeApiError(503, { error: "later" }),
    });
    expect(
      (
        await handlePageRequest(
          client,
          { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"], dcApiOrigin: "https://shop.example" },
          { start: { credentialType: "eu_pid_mdoc" } },
        )
      ).status,
    ).toBe(201);
    expect(sentBody(f, 1).dcApiProtocols).toEqual(["org-iso-mdoc"]);
    await handlePageRequest(
      client,
      { action: "start", flow: "dc_api", dcApiProtocols: ["org-iso-mdoc"], dcApiOrigin: "https://shop.example" },
      { start: { credentialType: "eu_pid_mdoc" } },
    );
    expect(verifierCalls(f).filter((c) => c === "GET /v1/credential-types")).toHaveLength(2);
  });

  it("refuses a list that is not one or both of the two protocols, before calling the verifier", async () => {
    const { client, f } = clientWith({});
    for (const bad of ["org-iso-mdoc", [], ["openid4vp"], ["org-iso-mdoc", "org-iso-mdoc"], [7]]) {
      const refused = await handlePageRequest(client, { action: "start", flow: "dc_api", dcApiProtocols: bad });
      expect(refused.status).toBe(400);
      expect((refused.reply as { error: string }).error).toBe(
        '"dcApiProtocols" lists "openid4vp-v1-signed" and/or "org-iso-mdoc", each once.',
      );
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("sends neither with a link start, whatever the page or the server's option says", async () => {
    const { client, f } = clientWith({
      "POST /v1/verifications": { ...STARTED, flow: "cross_device", authorizationRequestUri: "openid4vp://x" },
    });
    await handlePageRequest(
      client,
      { action: "start", flow: "cross_device", dcApiProtocols: ["org-iso-mdoc"], dcApiOrigin: "https://shop.example" },
      { start: { dcApiProtocols: ["org-iso-mdoc"], dcApiOrigin: "https://shop.example" } },
      { origin: "https://shop.example" },
    );
    expect(sentBody(f, 0)).toEqual({ flow: "cross_device" });
  });
});

describe("handlePageRequest", () => {
  it("refuses anything but the three calls", async () => {
    const { client, f } = clientWith({});
    expect((await handlePageRequest(client, null)).status).toBe(400);
    expect((await handlePageRequest(client, { action: "read" })).status).toBe(400);
    expect((await handlePageRequest(client, { action: "start", flow: "magic" })).status).toBe(400);
    expect((await handlePageRequest(client, { action: "status" })).status).toBe(400);
    expect((await handlePageRequest(client, { action: "exchange", id: "v1" })).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("starts the browser prompt and gives the page only what it needs", async () => {
    const { client, f } = clientWith({ "POST /v1/verifications": STARTED });
    const result = await handlePageRequest(
      client,
      { action: "start", flow: "dc_api" },
      { start: { claims: ["given_name"], linkScheme: "haip-vp://", reference: "order-1" } },
    );
    expect(result.status).toBe(201);
    expect(result.reply).toEqual({
      id: "v1",
      flow: "dc_api",
      status: "pending",
      dcApiRequests: STARTED.dcApiRequests,
      dcApiResponseUrl: STARTED.dcApiResponseUrl,
    });
    expect(result.started).toEqual(STARTED);
    const sent = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({ flow: "dc_api", claims: ["given_name"], reference: "order-1" });
  });

  it("refuses a same-device start without a return page, before calling the verifier", async () => {
    const { client, f } = clientWith({});
    const result = await handlePageRequest(client, { action: "start", flow: "same_device" });
    expect(result.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the return page with a same-device start, and never with the others", async () => {
    const { client, f } = clientWith({
      "POST /v1/verifications": { ...STARTED, flow: "same_device", authorizationRequestUri: "openid4vp://x" },
    });
    await handlePageRequest(
      client,
      { action: "start", flow: "same_device" },
      { returnUrl: (flow) => `https://shop.example/return/${flow}`, start: { returnUrl: "https://ignored.example" } },
    );
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      flow: "same_device",
      returnUrl: "https://shop.example/return/same_device",
    });
    await handlePageRequest(
      client,
      { action: "start", flow: "cross_device" },
      { returnUrl: "https://shop.example/return", start: { returnUrl: "https://ignored.example" } },
    );
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({
      flow: "cross_device",
    });
  });

  it("offers only the flows allowed", async () => {
    const { client, f } = clientWith({});
    expect(
      (
        await handlePageRequest(
          client,
          { action: "start", flow: "cross_device" },
          { allowFlows: ["dc_api", "same_device"] },
        )
      ).status,
    ).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("answers a status with the status alone, and hands the claims to the server", async () => {
    const { client } = clientWith({
      "GET /v1/verifications/v1": {
        id: "v1",
        status: "verified",
        flow: "cross_device",
        result: { claims: { given_name: "Test" } },
      },
    });
    const result = await handlePageRequest(client, { action: "status", id: "v1" });
    expect(result.status).toBe(200);
    expect(result.reply).toEqual({ id: "v1", status: "verified" });
    expect(JSON.stringify(result.reply)).not.toContain("Test");
    expect(result.verification?.result).toEqual({ claims: { given_name: "Test" } });
  });

  it("exchanges a code and hands the claims to the server, the page getting the status", async () => {
    const { client, f } = clientWith({
      "POST /v1/verifications/v1/exchange": {
        id: "v1",
        status: "verified",
        flow: "same_device",
        result: { claims: { given_name: "Test" } },
      },
    });
    const result = await handlePageRequest(client, { action: "exchange", id: "v1", responseCode: "c0de" });
    expect(result.reply).toEqual({ id: "v1", status: "verified" });
    expect(result.verification?.result).toEqual({ claims: { given_name: "Test" } });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      responseCode: "c0de",
    });
  });

  it("asks the server whether this session owns the verification", async () => {
    const { client, f } = clientWith({});
    const result = await handlePageRequest(
      client,
      { action: "status", id: "v1" },
      { ownsVerification: async () => false },
    );
    expect(result.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes the verifier's refusals through, and hides its key and outage errors", async () => {
    const budget = new VerySafeApiError(429, { error: "budget" }, 5);
    const { client } = clientWith({ "GET /v1/verifications/v1": budget });
    const result = await handlePageRequest(client, { action: "status", id: "v1" });
    expect(result).toEqual({ status: 429, reply: { error: "budget" } });

    const unauthorised = new VerySafeApiError(401, { error: "bad key" });
    const errors: unknown[] = [];
    const c2 = clientWith({ "GET /v1/verifications/v1": unauthorised });
    const r2 = await handlePageRequest(c2.client, { action: "status", id: "v1" }, { onError: (e) => errors.push(e) });
    expect(r2.status).toBe(502);
    expect(JSON.stringify(r2.reply)).not.toContain("bad key");
    expect(errors).toHaveLength(1);

    const c3 = clientWith({});
    expect((await handlePageRequest(c3.client, { action: "status", id: "v1" })).status).toBe(502);
  });
});
