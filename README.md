# @verysafe/verify

The browser library for [VerySafe](https://verysafe.id)'s EU wallet verifier.
A customer's page includes it, and the page tries the ways a person can
present in the order EU law ranks them: the **browser prompt** where the
browser has it, else a **link** that opens the wallet on a phone, else a
**QR code** on a computer. A server half, for Node, answers the page with the
key, which never reaches the page.

| The page tries | When | How the answer comes back |
|---|---|---|
| The browser prompt (W3C Digital Credentials API, OpenID4VP) | Chrome 141 or later on Android and on a computer. From a computer the browser shows its own QR code and checks Bluetooth proximity itself | The browser hands the page an encrypted answer; the page relays it to the verifier, unopened |
| A link that opens the wallet | On a phone whose browser has no prompt: an iPhone today, since Safari speaks only the ISO mdoc protocol, which the verifier does not yet | The wallet posts to the verifier and sends the person back to your page with a `response_code`, which your server exchanges |
| A QR code the page draws | On a computer whose browser has no prompt | The wallet posts to the verifier; the page asks your server until it has |

Three parties: **you**, the customer, with an API key on your server; **the
person**, with a wallet on their phone, who installs nothing; and the
verifier. Your page runs in the person's browser on your origin, which is
why the verifier needs that origin registered for your key.

## Install

```bash
npm install @verysafe/verify
```

Or one `<script>` tag, which registers `<verysafe-verify>` on load:

```html
<script src="https://cdn.jsdelivr.net/npm/@verysafe/verify@0.1.0/dist/verysafe-verify.iife.js"></script>
```

## Your server

The server half answers the page's three calls with your key, and gives the
page a status, never a claim. With Node's own `http`:

```js
import { createServer } from "node:http";
import { createClient, handleNodeRequest } from "@verysafe/verify/server";

const client = createClient({ baseUrl: "https://verify.verysafe.id", apiKey: process.env.VERYSAFE_API_KEY });

createServer(async (request, response) => {
  if (request.url === "/api/verify") {
    const { verification } = await handleNodeRequest(client, request, response, {
      returnUrl: "https://shop.example/verify",          // where the wallet sends the person back (same device)
      start: { claims: ["age_over_18"] },                // what every start asks for
    });
    if (verification?.status === "verified") {
      // The claims are here and nowhere else: verification.result
    }
  }
}).listen(8080);
```

With Express, Fastify or anything that parses JSON for you, call
`handlePageRequest(client, req.body, options)` and send back its `status`
and `reply`. Read the result yourself, from `verification`: never from what
a page tells you.

## Your page

```js
import { verify, complete, httpTransport } from "@verysafe/verify/browser";

const transport = httpTransport("/api/verify");

// On the return page, first: finishes a same-device verification, if this is one.
const returned = await complete({ transport });

// On a click:
const result = await verify({ transport, qrElement: document.querySelector("#qr") });
// { outcome: "verified" | "failed" | "expired", id, flow }
// { outcome: "redirected", id }            the wallet is opening on this phone
// { outcome: "cancelled", fallback }       the person dismissed the prompt; offer `fallback` if you like
```

Or the element, which does both and dispatches `verysafe-verify:flow`,
`verysafe-verify:fallback`, `verysafe-verify:status` and
`verysafe-verify:result` events:

```html
<verysafe-verify endpoint="/api/verify" label="Verify with your EU wallet"></verysafe-verify>
```

Style it from your page with `::part(button)`, `::part(qr)` and
`::part(status)`. It needs no inline style or script, so a strict Content
Security Policy is no obstacle; allow the verifier's origin in
`connect-src`, since the page relays the browser prompt's answer there.

**What the page learns is for the screen only.** After the prompt's answer is
relayed, the page asks your server for the status once, so your server reads
the verification with its key at once; a `verified` on the page is your
server's own word. Act on `verification`, as `handleNodeRequest` gives it,
never on what a page tells you.

## The three calls

The page posts each as JSON to one endpoint of yours. A server on any
platform implements them with the verifier's public API
([`GET /openapi.json`](https://verify.verysafe.id/openapi.json)):

| The page sends | Your server does | Your server answers |
|---|---|---|
| `{"action": "start", "flow": "dc_api" \| "same_device" \| "cross_device"}` | `POST /v1/verifications` with that `flow`, your `returnUrl` for `same_device`, and what you ask for | `{id, flow, status, authorizationRequestUri?, dcApiRequests?, dcApiResponseUrl?}` |
| `{"action": "status", "id"}` | `GET /v1/verifications/{id}` | `{id, status}` |
| `{"action": "exchange", "id", "responseCode"}` | `POST /v1/verifications/{id}/exchange` | `{id, status}` |

The page never receives a claim, a reference or a key. On a same-device
return, the page takes the `id` from the browser's own storage for your
origin, kept for 15 minutes and never read from the URL, and your server
exchanges the code with it: that is the check HAIP
1.0 §5.1 asks for, and a browser that arrives with a code but no session
gets nothing.

## What to register for your key

- **A return origin** for the link: the origin of the page the wallet sends
  the person back to.
- **A browser origin** for the prompt: the origin of the page that calls it.

On the hosted service, ask VerySafe to add them to your customer record; on a
self-hosted installation they are its `RETURN_URL_ORIGINS` and
`DC_API_ORIGINS`.

## Browsers

- **Chrome 141 or later**, Android and computer: the prompt. The library asks
  the browser whether it allows `openid4vp-v1-signed`, through the W3C API's
  own check where the browser has it.
- **Safari, and every browser on an iPhone**: the prompt offers only
  `org-iso-mdoc`, which the verifier does not speak yet, so the library opens
  the wallet by link. Chrome on an iPhone runs on Safari's engine.
- **Everything else**: a link on a phone, a QR code on a computer. Chrome on
  Android asks the person whether they trust the site before it opens the
  wallet from a link, and the wallet brings them back in a new tab.

## Versions

| Package | Verifier API |
|---|---|
| 0.1.0 | The API as of 2026-10-12. A start always carries `flow`, which the hosted service requires from 2026-11-04 |

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Security reports:
[SECURITY.md](SECURITY.md).
