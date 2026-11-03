import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION_FILES } from "./version-files.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PLUGIN_NAME = "agent-github"
const SERVER_NAME = "github"
const MCP_ENTRY = "dist/mcp.js"
const REGISTRY_DESCRIPTION_LIMIT = 100

/** Each MCP configuration and the variable its harness expands to the plugin's install directory. */
const MCP_CONFIGS = {
  "mcp.json": "${PLUGIN_ROOT}",
  ".claude-plugin/plugin.json": "${CLAUDE_PLUGIN_ROOT}",
  "mcp_config.json": "${PLUGIN_ROOT}",
}

/** Each marketplace and the plugin entries it lists. */
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]

const read = (file) => readFileSync(join(ROOT, file), "utf8")
const readJson = (file) => JSON.parse(read(file))

const pkg = readJson("package.json")

/** Whether npm packs `path` for a `files` list: named itself, or inside a directory it names. */
function isPacked(path, files) {
  return files.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

describe("version files", () => {
  const jsonFiles = VERSION_FILES.filter((file) => file.endsWith(".json"))

  test.each(jsonFiles)("%s carries the package's version at its top level", (file) => {
    expect(readJson(file).version).toBe(pkg.version)
  })

  test("plugin.yaml carries the package's version", () => {
    expect(read("plugin.yaml").match(/^version: (.+)$/m)?.[1]).toBe(pkg.version)
  })

  test.each(jsonFiles)("%s names the plugin", (file) => {
    expect(readJson(file).name).toBe(PLUGIN_NAME)
  })
})

describe("MCP configurations", () => {
  test.each(Object.entries(MCP_CONFIGS))("%s launches dist/mcp.js through %s", (file, root) => {
    expect(readJson(file).mcpServers).toEqual({
      [SERVER_NAME]: expect.objectContaining({ command: "node", args: [`${root}/${MCP_ENTRY}`] }),
    })
  })

  test("the package's own name runs the MCP server, and agent-github-cli the command line", () => {
    expect(pkg.bin).toEqual({ [PLUGIN_NAME]: MCP_ENTRY, "agent-github-cli": "dist/cli.js" })
  })
})

describe("marketplaces", () => {
  test.each(MARKETPLACES)("%s lists the plugin once, from the repository root", (file) => {
    const entries = readJson(file).plugins
    expect(entries.map((entry) => entry.name)).toEqual([PLUGIN_NAME])
    const [{ source }] = entries
    expect(typeof source === "string" ? source : source.path).toBe("./")
  })
})

describe("package files", () => {
  const manifests = [
    ...VERSION_FILES,
    ...Object.keys(MCP_CONFIGS),
    ...MARKETPLACES,
    "__init__.py",
    "src/hermes/agent_github_hermes",
  ]

  test.each(["dist", ...manifests])("%s is packed", (path) => {
    expect(isPacked(path, pkg.files)).toBe(true)
  })

  test("the Hermes tests are not packed", () => {
    expect(isPacked("src/hermes/tests", pkg.files)).toBe(false)
  })
})
