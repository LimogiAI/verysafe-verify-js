# CLAUDE.md — verysafe-verify-js

The browser library for VerySafe's EU wallet verifier, `@verysafe/verify`.
How we work is in [`CONTRIBUTING.md`](CONTRIBUTING.md); this adds what an
agent needs beyond it.

- **It is the browser side of a verifier of identity documents.** A defect
  is not a bad experience: it is a page acting on an answer it should not
  have, or a key leaving a server. Move deliberately.
- **The browser half never holds a key** and never reads a claim. The server
  half talks to one `baseUrl` with the key and gives a page a status only.
- **Open the pull request and enable auto-merge** (`gh pr merge <n> --auto
  --squash`). The checks are the review, after your own reading of the diff.
- **No AI attribution** in commits, pull requests, comments or branch names.
  Never push a `claude/…` branch: branch off with `type/` first.
- **Prove with a browser and a wallet**, not only with tests, and say in the
  pull request what was verified and what was not.
- The verifier's rules, decisions and API live in the private
  `LimogiAI/eudi-verifier` repository; its API description is public at
  `GET /openapi.json` on `https://verify.verysafe.id`.
