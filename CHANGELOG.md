# Changelog

All notable changes to `@verysafe/verify`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
Semantic Versioning on this package's own line.

## Unreleased

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
