import { build } from "esbuild"
import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

await build({
  entryPoints: ["src/mcp/main.ts"],
  outfile: "dist/mcp.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "info",
})
