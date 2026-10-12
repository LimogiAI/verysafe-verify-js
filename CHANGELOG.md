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
