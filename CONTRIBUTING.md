# Contributing

This package is the browser side of [VerySafe's EU wallet verifier](https://verysafe.id).
The verifier's own repository, its rules and its decisions are private; what
this package needs of the API is public at `GET /openapi.json` on the service.

## How changes land

- **One pull request per change**, titled `type(scope): summary` in the
  imperative with no trailing full stop; the title becomes the commit on
  `main`, because merges are squashes. Types: `build`, `chore`, `ci`, `docs`,
  `feat`, `fix`, `perf`, `refactor`, `revert`, `test`.
- **Pull requests merge themselves on green.** Open it, enable auto-merge
  (`gh pr merge <n> --auto --squash`); the `verify` and `pr-title` checks are
  the review, with your own reading of the diff before you enable it.
- **Prove it, do not assert it.** A test that fails without the change is the
  floor. For anything a page does, run it in a browser against the sandbox
  service; for anything a wallet does, a real wallet, named in the pull
  request with what came back.
- **Docs change with the code**, in the same pull request: `README.md`, and a
  line under "Unreleased" in `CHANGELOG.md` for anything a user would notice.
- **No AI attribution** anywhere: not in commits, pull request bodies, code
  comments or branch names. No `Co-Authored-By` trailer, no "Generated with".
- **Never a key in the browser half.** The browser half talks to the
  customer's server and to the verifier's keyless relay, and to nothing else.

## Running it

```bash
nvm use            # Node 24, from .nvmrc
npm ci
npm run typecheck && npm run lint && npm test && npm run build
npm run example    # a page and a server on http://127.0.0.1:8790, see examples/
```

## Releasing

Versions follow [Semantic Versioning](https://semver.org/) on this package's
own line: a major means a page or a server has to change its code. Bump
`package.json` and `src/version.ts` (a test keeps them equal), move
"Unreleased" to the version in `CHANGELOG.md`, tag `v<version>` on `main`.
The `publish` workflow publishes it to npm with provenance, which only CI
can attach; a publish by hand (the first one, 0.1.0, was) needs
`--provenance=false`.
