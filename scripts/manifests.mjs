import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Keeps the generated fields of `plugin.yaml` — `version` and `provides_tools` —
 * in step with package.json and the tools the built CLI lists. The rest of the
 * file is written by hand. `--check` writes nothing and fails when it is out of date.
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))
const MANIFEST = new URL("../plugin.yaml", import.meta.url)
const PACKAGE = new URL("../package.json", import.meta.url)
const VERSION_LINE = /^version:.*$/m
const PROVIDES_TOOLS_BLOCK = /^provides_tools:.*(?:\n[ \t]+-.*)*$/m

function listedToolIds() {
  const run = spawnSync(process.execPath, [CLI, "list", "--toolsets", "all"], { encoding: "utf8", stdio: "pipe" })
  if (run.status !== 0) {
    throw new Error(`\`dist/cli.js list\` failed (exit ${run.status}); run \`pnpm run build\` first.\n${run.stderr}`)
  }
  return JSON.parse(run.stdout)
    .map((tool) => tool.id)
    .sort()
}

function replaceField(text, pattern, replacement, name) {
  if (!pattern.test(text)) throw new Error(`plugin.yaml has no \`${name}\` field to update.`)
  return text.replace(pattern, () => replacement)
}

function render(text, version, toolIds) {
  const provided =
    toolIds.length === 0 ? "provides_tools: []" : `provides_tools:\n${toolIds.map((id) => `  - ${id}`).join("\n")}`
  const withVersion = replaceField(text, VERSION_LINE, `version: ${version}`, "version")
  return replaceField(withVersion, PROVIDES_TOOLS_BLOCK, provided, "provides_tools")
}

try {
  const { version } = JSON.parse(readFileSync(PACKAGE, "utf8"))
  const current = readFileSync(MANIFEST, "utf8")
  const updated = render(current, version, listedToolIds())

  if (process.argv.includes("--check")) {
    if (updated !== current) {
      console.error("plugin.yaml is out of date; run `pnpm run build && pnpm run manifests` and commit the result.")
      process.exit(1)
    }
    console.log("plugin.yaml is up to date.")
  } else if (updated !== current) {
    writeFileSync(MANIFEST, updated)
    console.log("plugin.yaml updated.")
  } else {
    console.log("plugin.yaml is already up to date.")
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
