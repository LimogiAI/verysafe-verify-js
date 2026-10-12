// A customer's server, in forty lines: serves the page, answers its three
// calls with the key, and acts on the claims after an exchange. Run with:
//
//   VERYSAFE_BASE_URL=https://sandbox.verysafe.id VERYSAFE_API_KEY=… npm run example
//
// RETURN_BASE_URL (default http://127.0.0.1:8790) is where the wallet sends
// the person back; an https tunnel to this port, registered as a return
// origin and a browser origin for the key, lets a phone reach it. CLAIMS
// names the claims to ask for, LINK_SCHEME what a link starts with
// (openid4vp:// by default; haip-vp://, eu-eaap://, or a wallet's app link).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createClient, handleNodeRequest } from "../dist/server/index.js";

const baseUrl = process.env.VERYSAFE_BASE_URL ?? "https://sandbox.verysafe.id";
const apiKey = process.env.VERYSAFE_API_KEY;
if (!apiKey) {
  console.error("Set VERYSAFE_API_KEY (and VERYSAFE_BASE_URL, https://sandbox.verysafe.id by default).");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 8790);
const returnBase = (process.env.RETURN_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
const client = createClient({ baseUrl, apiKey });
const csp = `default-src 'self'; connect-src 'self' ${new URL(baseUrl).origin}; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", returnBase);
  if (url.pathname === "/api/verify") {
    const { verification } = await handleNodeRequest(client, request, response, {
      returnUrl: `${returnBase}/`,
      start: { claims: process.env.CLAIMS?.split(","), linkScheme: process.env.LINK_SCHEME },
      onError: (error) => console.error("verifier:", error instanceof Error ? error.message : error),
    });
    if (verification?.status === "verified") {
      // The claims are here, on the server, and nowhere else. An example
      // prints which claims came, never their values.
      const claims = verification.result && typeof verification.result === "object" ? Object.keys(verification.result.claims ?? {}) : [];
      console.log(`verified ${verification.id} (${verification.flow}): ${claims.join(", ")}`);
    }
    return;
  }
  const files = { "/": "page.html", "/page.js": "page.js", "/page.css": "page.css", "/verysafe-verify.iife.js": "../dist/verysafe-verify.iife.js", "/verysafe-verify.iife.js.map": "../dist/verysafe-verify.iife.js.map" };
  const file = files[url.pathname];
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  const body = await readFile(new URL(file, import.meta.url));
  const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css" : file.endsWith(".map") ? "application/json" : "text/javascript; charset=utf-8";
  response.writeHead(200, { "content-type": type, "content-security-policy": csp, "cache-control": "no-store" });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => console.log(`example page: http://127.0.0.1:${port}/  (verifier ${baseUrl}, return ${returnBase}/)`));
