import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DESCRIPTION, serverJson } from "./server-json.mjs"
import { VERSION_FILES } from "./version-files.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PLUGIN_NAME = "github-tools"
const SERVER_NAME = "github-tools"
const MCP_ENTRY = "dist/mcp.js"
const REGISTRY_DESCRIPTION_LIMIT = 100

/** Each MCP configuration and the variable its harness expands to the plugin's install directory. */
const MCP_CONFIGS = {
  "mcp.json": "${PLUGIN_ROOT}",
  ".claude-plugin/plugin.json": "${CLAUDE_PLUGIN_ROOT}",
  "mcp_config.json": "${PLUGIN_ROOT}",
  ".mcp.json": "${CLAUDE_PLUGIN_ROOT}",
}

/** Each marketplace and the plugin entries it lists. */
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]

const read = (file) => readFileSync(join(ROOT, file), "utf8")
const readJson = (file) => JSON.parse(read(file))

const pkg = readJson("package.json")

/** The paths the release workflow passes as `version-files`, one per line. */
function workflowVersionFiles() {
  const block = read(".github/workflows/release-publish.yml").match(/^( +)version-files: \|\n((?:\1 +\S.*\n)+)/m)
  if (!block) throw new Error("release-publish.yml has no `version-files` block.")
  return block[2]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Whether npm packs `path` for a `files` list: named itself, or inside a directory it names. */
function isPacked(path, files) {
  return files.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

describe("version files", () => {
  const jsonFiles = VERSION_FILES.filter((file) => file.endsWith(".json"))

  test("the release workflow bumps exactly the files manifests.mjs checks", () => {
    expect(workflowVersionFiles()).toEqual(VERSION_FILES)
  })

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

  test("every MCP configuration declares exactly one server and all use the same name", () => {
    for (const file of Object.keys(MCP_CONFIGS)) {
      const servers = Object.keys(readJson(file).mcpServers ?? {})
      expect(servers).toEqual([SERVER_NAME])
    }
  })

  test("github-tools runs the MCP server, and github-tools-cli the command line", () => {
    expect(pkg.bin).toEqual({ "github-tools": MCP_ENTRY, "github-tools-cli": "dist/cli.js" })
    // npx runs the bin named like the unscoped package name when a package provides several bins.
    const unscoped = pkg.name.replace(/^@[^/]+\//, "")
    expect(pkg.bin[unscoped]).toBe(MCP_ENTRY)
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

describe("server.json", () => {
  test("is built from package.json", () => {
    const server = serverJson(pkg)
    expect(server).toMatchObject({ name: pkg.mcpName, version: pkg.version })
    expect(server.packages).toEqual([
      { registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } },
    ])
    expect(server.repository).toEqual({ url: "https://github.com/craft-agent/github-tools", source: "github" })
  })

  test("names the registry namespace the repository's owner holds", () => {
    expect(pkg.mcpName).toBe("io.github.craft-agent/github-tools")
  })

  test("describes the server within the registry's limit", () => {
    expect(DESCRIPTION.length).toBeLessThanOrEqual(REGISTRY_DESCRIPTION_LIMIT)
  })

  test("the script writes the same document", () => {
    const dir = mkdtempSync(join(tmpdir(), "github-tools-server-json-"))
    try {
      const output = join(dir, "server.json")
      const run = spawnSync(process.execPath, [join(ROOT, "scripts/server-json.mjs"), output], { encoding: "utf8" })
      expect(run.status).toBe(0)
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(serverJson(pkg))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("refuses a package without mcpName", () => {
    expect(() => serverJson({ ...pkg, mcpName: undefined })).toThrow(/mcpName/)
  })
})
