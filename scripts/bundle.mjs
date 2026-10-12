// Bundles the browser half for a <script> tag: one file, a global
// `VerySafeVerify`, the element registered on load. Served from npm by any
// CDN; nothing of ours hosts it.
import { build } from "esbuild";

await build({
  entryPoints: ["src/browser/iife.ts"],
  bundle: true,
  format: "iife",
  globalName: "VerySafeVerify",
  outfile: "dist/verysafe-verify.iife.js",
  minify: true,
  sourcemap: true,
  target: ["es2020"],
  legalComments: "linked",
  logLevel: "warning",
});
