// Bundle the extension host into a single self-contained out/extension.js so the
// installed vsix doesn't depend on the monorepo's hoisted node_modules (F5
// resolves up the tree; an installed extension does not). vscode is provided by
// the runtime; everything else — the shared *.mjs (pulled in via static-string
// dynamic imports), @anthropic-ai/sdk, ajv — gets inlined.
import esbuild from "esbuild";

const options = {
  entryPoints: ["host/extension.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "out/extension.js",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild: watching host…");
} else {
  await esbuild.build(options);
}
