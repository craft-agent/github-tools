import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { REQUIRES_USER_INTERACTION, ToolError, annotations, defineTool, selectTools } from "../core"
import type { EntrySettings } from "../entry/settings"
import { createServer } from "./server"
import {
  call,
  connect,
  failing,
  runCleanups,
  settings,
  textOf,
  tool,
  toolInput,
  toolOutput,
  type Call,
} from "./testing"

afterEach(runCleanups)

describe("tool list", () => {
  const calls: Call[] = []
  const specs = [
    tool("github_issue_read", "issues", "read", calls),
    tool("github_issue_create", "issues", "add", calls),
    tool("github_issue_label", "issues", "idempotent", calls),
    tool("github_issue_edit", "issues", "overwrite", calls),
    tool("github_repo_read", "repos", "read", calls),
    tool("github_repo_delete", "repos", "administrative", calls),
  ]
  const names = async (entry: EntrySettings) => {
    const { client } = await connect(specs, entry)
    return (await client.listTools()).tools.map((t) => t.name)
  }

  test("follows selectTools: the default toolsets", async () => {
    expect(await names(settings())).toEqual(selectTools(specs, {}).map((s) => s.id))
    expect(await names(settings())).toEqual([
      "github_issue_read",
      "github_issue_create",
      "github_issue_label",
      "github_issue_edit",
    ])
  })

  test("follows selectTools: toolsets, read_only, tools and exclude_tools", async () => {
    for (const given of [
      { toolsets: "all" as const },
      { toolsets: "all" as const, read_only: true },
      { tools: ["github_repo_delete"] },
      { exclude_tools: ["github_issue_edit"] },
      { toolsets: ["repos" as const], exclude_tools: ["github_repo_read"] },
    ]) {
      expect(await names(settings(given))).toEqual(selectTools(specs, given).map((s) => s.id))
    }
  })

  test("a server with no tool selected lists none", async () => {
    expect(await names(settings({ toolsets: ["projects"] }))).toEqual([])
  })

  test("an unknown tool id in the settings fails createServer", () => {
    expect(() => createServer(specs, settings({ tools: ["github_nope_read"] }))).toThrow(/github_nope_read/)
  })

  test("publishes the title, description, annotations and meta of each class", async () => {
    const { client } = await connect(specs, settings({ toolsets: "all" }))
    const { tools } = await client.listTools()
    for (const spec of specs) {
      const listed = tools.find((t) => t.name === spec.id)!
      expect(listed.title).toBe(spec.title)
      expect(listed.description).toBe(spec.description)
      expect(listed.annotations).toEqual(annotations(spec))
      expect(listed._meta).toEqual(spec.class === "administrative" ? { [REQUIRES_USER_INTERACTION]: true } : undefined)
    }
  })

  test("publishes an object output schema and an input schema that forbids extra properties", async () => {
    const { client } = await connect(specs, settings())
    for (const listed of (await client.listTools()).tools) {
      expect(listed.outputSchema?.type).toBe("object")
      expect(listed.outputSchema?.required).toEqual(["tool"])
      expect(listed.inputSchema.type).toBe("object")
      expect(listed.inputSchema.additionalProperties).toBe(false)
    }
  })
})
