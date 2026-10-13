import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/server/client.js";
import { handleNodeRequest } from "../src/server/node.js";

const verifier = vi.fn(
  async (_url: string, init: RequestInit) =>
    new Response(
      JSON.stringify({ id: "v1", status: "pending", flow: "cross_device", authorizationRequestUri: "openid4vp://x" }),
      { status: init.method === "POST" ? 201 : 200 },
    ),
);
const client = createClient({
  baseUrl: "https://verify.example",
  apiKey: "secret",
  fetch: verifier as unknown as typeof fetch,
});
const server = createServer((request, response) => void handleNodeRequest(client, request, response));
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("handleNodeRequest", () => {
  it("answers the page's start as JSON, uncached", async () => {
    const response = await fetch(`${base}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", flow: "cross_device" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: "v1",
      flow: "cross_device",
      status: "pending",
      authorizationRequestUri: "openid4vp://x",
    });
  });

  it("passes the request's Origin header to the handler, which names the page for the ISO mdoc protocol", async () => {
    const bodies: unknown[] = [];
    const typed = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/credential-types"))
        return new Response(JSON.stringify({ credentialTypes: [{ id: "eu_pid_mdoc", format: "mso_mdoc" }] }), {
          status: 200,
        });
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: "v2",
          status: "pending",
          flow: "dc_api",
          dcApiRequests: [],
          dcApiResponseUrl: "https://verify.example/r",
        }),
        { status: 201 },
      );
    });
    const mdocClient = createClient({
      baseUrl: "https://verify.example",
      apiKey: "secret",
      fetch: typed as unknown as typeof fetch,
    });
    const mdocServer = createServer(
      (request, response) =>
        void handleNodeRequest(mdocClient, request, response, { start: { credentialType: "eu_pid_mdoc" } }),
    );
    await new Promise<void>((resolve) => mdocServer.listen(0, "127.0.0.1", resolve));
    const address = mdocServer.address();
    const mdocBase = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
    try {
      const response = await fetch(`${mdocBase}/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://shop.example" },
        body: JSON.stringify({
          action: "start",
          flow: "dc_api",
          dcApiProtocols: ["org-iso-mdoc"],
          dcApiOrigin: "https://claimed.example",
        }),
      });
      expect(response.status).toBe(201);
      expect(bodies).toEqual([
        {
          flow: "dc_api",
          credentialType: "eu_pid_mdoc",
          dcApiProtocols: ["org-iso-mdoc"],
          dcApiOrigin: "https://shop.example",
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => mdocServer.close(() => resolve()));
    }
  });

  it("refuses GET, a body that is not JSON, and a body too large", async () => {
    expect((await fetch(`${base}/api/verify`)).status).toBe(405);
    expect((await fetch(`${base}/api/verify`, { method: "POST", body: "nope" })).status).toBe(400);
    expect((await fetch(`${base}/api/verify`, { method: "POST", body: "x".repeat(20_000) })).status).toBe(413);
  });
});
