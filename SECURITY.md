# Security

Report a vulnerability in this package to security@verysafe.id, not in a
public issue. We answer within two working days.

What this package does and does not hold:

- The browser half never holds the API key. It calls the customer's own
  server for a start, a status and an exchange, and the verifier's keyless
  relay with the browser's answer, unopened.
- The server half holds the key on the customer's server and sends it only to
  the verifier named in `baseUrl`, which must be https off the machine itself.
- A page never sees a claim: the server half answers a page with a status
  only, and hands the claims to the server's own code.
- A same-device return is finished with the verification id from the
  browser's own session, never from the URL (HAIP 1.0 §5.1).
