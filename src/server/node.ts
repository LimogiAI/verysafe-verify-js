import type { IncomingMessage, ServerResponse } from "node:http";
import type { VerySafeClient } from "./client.js";
import { handlePageRequest, type PageHandlerOptions, type PageHandlerResult } from "./page.js";

/** The most a page's request body may be; the three calls are a few hundred bytes. */
export const MAX_PAGE_BODY_BYTES = 16 * 1024;

/** Reads a request's body as JSON, refusing one over `limit` bytes. */
export function readJsonBody(request: IncomingMessage, limit = MAX_PAGE_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RangeError("The body is too large."));
        request.removeAllListeners("data");
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new SyntaxError("The body is not JSON."));
      }
    });
    request.on("error", reject);
  });
}

/**
 * Answers the page's call on a `node:http` server: reads the JSON body, runs
 * `handlePageRequest`, writes the reply. Returns what the handler returned,
 * so the server can act on `verification` after an exchange.
 */
export async function handleNodeRequest(
  client: VerySafeClient,
  request: IncomingMessage,
  response: ServerResponse,
  options: PageHandlerOptions = {},
): Promise<PageHandlerResult> {
  let result: PageHandlerResult;
  if (request.method !== "POST") {
    result = { status: 405, reply: { error: "Post the page's call as JSON." } };
  } else {
    let body: unknown;
    try {
      body = await readJsonBody(request);
      result = await handlePageRequest(client, body, options);
    } catch (error) {
      result = {
        status: error instanceof RangeError ? 413 : 400,
        reply: { error: error instanceof Error ? error.message : "The body could not be read." },
      };
    }
  }
  response.statusCode = result.status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(result.reply));
  return result;
}
