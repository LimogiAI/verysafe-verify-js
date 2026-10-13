# Changelog

All notable changes to `@verysafe/verify`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
Semantic Versioning on this package's own line.

## Unreleased

Nothing yet.

## [0.2.0] - 2026-10-13

Proven on VerySafe's production service through a customer page on
2026-10-13: the EU reference wallet on Android answered OpenID4VP with the
default order and the ISO mdoc protocol with that one listed first, and
Safari on an iPhone (iOS 26) answered the ISO mdoc protocol; the record is in
the verifier's interop document.

### Added

- The ISO mdoc protocol, `org-iso-mdoc`, the only one Safari has (#14). The
  page tells the server which prompt protocols its browser allows and its
  origin (`dcApiProtocols` and `dcApiOrigin` in the start call; `Transport.start`
  takes them, `promptStartOptions` makes them); the server half forwards
  them to the verifier, narrowed to `start.dcApiProtocols` when set, and
  keeps the ISO protocol only for an mdoc `credentialType`, which it learns
  from `GET /v1/credential-types` once (`client.credentialTypes()`). The
  request's `Origin` header names the page (`handlePageRequest`'s new
  `context`; `handleNodeRequest` passes it). The element takes a `protocols`
  attribute. A start whose requests are all in a protocol the browser lacks
  falls back to a link before the prompt is tried.

### Changed

- `DEFAULT_PROTOCOLS` is both protocols, OpenID4VP first: on Android the EU
  wallet keeps answering OpenID4VP, and Safari on iOS 26 gets the prompt for
  an mdoc instead of a link. The verifier's own default, OpenID4VP alone, is
  what a start without `dcApiProtocols` still gets.

## [0.1.1] - 2026-10-13

The first version published by the `publish` workflow through npm's trusted
publishing, with provenance.

### Added

- The tab that opened the wallet learns the result when the tab the wallet
  brought the person back to has finished the exchange: `verify` takes
  `onReturn`, the element shows the outcome and dispatches
  `verysafe-verify:result` in that first tab too. Through the browser's
  storage for the origin, so not in Private Browsing (#8).

### Changed

- The published manifest no longer asks for provenance itself; the publish
  workflow does. A publish by hand needs `--provenance=false`.

## [0.1.0] - 2026-10-12

The first release: proven with the EU reference wallet on Android (Chrome)
and iOS (Safari) against VerySafe's sandbox and production services on
2026-10-12; the record is in the verifier's interop document.

### Added

- The browser half (`@verysafe/verify/browser`): `detect`, `verify`,
  `complete`, `httpTransport`, `qrSvg`, and the `<verysafe-verify>` element.
  It tries the browser prompt where the browser allows `openid4vp-v1-signed`,
  else a link on a phone, else a QR code, and relays the prompt's answer to
  the verifier's keyless relay.
- The server half (`@verysafe/verify/server`): `createClient`,
  `handlePageRequest`, `handleNodeRequest`. It answers the page's three
  calls with the key and gives the page a status, never a claim.
- A `<script>` bundle, `@verysafe/verify/iife`, that registers the element
  on load.
- A same-device verification's id is kept in the browser's storage for the
  page's origin (`localStorage`, for 15 minutes), not in `sessionStorage`: a
  wallet on Android brings the person back in a new tab, which has no session
  storage of its own. Found in a round trip with the EU reference wallet on
  Android on 2026-10-12. The element finishes a return after the page's own
  scripts have run, so they see the result.
- No wasted starts: a start made ahead is used for the QR code too; a return
  page finishes before it makes a start ready; a tab that handed off to the
  wallet makes none until it is shown again.
- The README says what Private Browsing does to a same-device return, and
  that a link opens only a wallet that registers its scheme, with the EU
  reference wallet's iOS build from Trinsic as the example; the example page
  prints storage diagnostics on load. From the iPhone round trip of 2026-10-12.
- The element starts the prompt's or the link's verification ahead of the tap,
  on page load, and refreshes it every four minutes; `verify` takes such a
  start as `prepared`. Chrome opens a prompt only within seconds of the tap
  ("requires transient activation"), too short for a start through the
  customer's server and the verifier. Found in the production round trip of
  2026-10-12. Each page load therefore starts a verification.
- After the browser prompt's answer is relayed, the page asks the customer's
  server for the status once, so the server reads the result with its key at
  once, within the verifier's 15 minutes, and the server's word is the page's
  outcome. Found in the production round trip of 2026-10-12, where the
  example server never read a result the relay had verified.
- A cancelled prompt carries the browser's own error as `reason`, and a
  fallback's reason names it too, so a page can tell a dismissal from a
  browser that found no wallet.
- `verify` falls back from the prompt when the customer's server refuses the
  prompt's start (a page origin not registered, say), and tells the page why
  through `onFallback`; the element dispatches `verysafe-verify:fallback`.

[0.1.1]: https://github.com/LimogiAI/verysafe-verify-js/releases/tag/v0.1.1
[0.1.0]: https://github.com/LimogiAI/verysafe-verify-js/releases/tag/v0.1.0
