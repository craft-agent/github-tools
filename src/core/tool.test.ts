import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError, isToolError } from "./errors"
import {
  DEFAULT_TOOLSETS,
  REQUIRES_USER_INTERACTION,
  TOOLSETS,
  annotations,
  confirmWrite,
  defineTool,
  selectTools,
  toolMeta,
  type ToolContext,
  type ToolSpec,
  type Toolset,
  type WriteClass,
} from "./tool"

const input = z.object({ count: z.number().int(), label: z.string().optional() })
const output = z.object({ total: z.number() })

function spec(id: string, toolset: Toolset, writeClass: WriteClass): ToolSpec {
  return defineTool({
    id,
    title: id,
    description: "A test tool.",
    toolset,
    class: writeClass,
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  })
}

const CTX: ToolContext = { cwd: process.cwd() }

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

describe("defineTool", () => {
  const base = {
    title: "T",
    description: "d",
    toolset: "issues",
    class: "add",
    input,
    output,
    execute: async () => ({ total: 1 }),
  } as const

  test("returns the spec it was given", () => {
    const given = { ...base, id: "github_issue_create" }
    expect(defineTool(given)).toBe(given)
  })

  test.each(["github_issue_create", "github_project_item_add", "github_issue_read"])("accepts %s", (id) => {
    expect(() => defineTool({ ...base, id })).not.toThrow()
  })

  test.each([
    "issue_create",
    "github_issue",
    "github_Issue_create",
    "github_issue_create2",
    "github__issue",
    "github_issue-create",
    "mcp_github_issue_create",
  ])("rejects the id %s", (id) => {
    expect(() => defineTool({ ...base, id })).toThrow(/github_<domain>_<verb>/)
  })

  test("rejects an id over 40 characters", () => {
    const id = `github_${"a".repeat(20)}_${"b".repeat(13)}`
    expect(id.length).toBe(41)
    expect(() => defineTool({ ...base, id })).toThrow(/40/)
    expect(() => defineTool({ ...base, id: id.slice(0, 40) })).not.toThrow()
  })

  test("a read tool's id must end in _read", () => {
    expect(() => defineTool({ ...base, id: "github_issue_list", class: "read" })).toThrow(/_read/)
    expect(() => defineTool({ ...base, id: "github_issue_read", class: "read" })).not.toThrow()
  })

  test("throws a plain Error, not a ToolError", () => {
    try {
      defineTool({ ...base, id: "nope" })
    } catch (error) {
      expect(isToolError(error)).toBe(false)
      expect(error).toBeInstanceOf(Error)
    }
  })
})

describe("annotations", () => {
  const tool = (writeClass: WriteClass) => ({ title: "Title", class: writeClass })

  test("read", () => {
    expect(annotations(tool("read"))).toEqual({
      title: "Title",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect("destructiveHint" in annotations(tool("read"))).toBe(false)
  })

  test("add", () => {
    expect(annotations(tool("add"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("idempotent", () => {
    expect(annotations(tool("idempotent"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("overwrite", () => {
    expect(annotations(tool("overwrite"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("administrative", () => {
    expect(annotations(tool("administrative"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
  })
})

describe("toolMeta", () => {
  test("only administrative tools require user interaction", () => {
    expect(toolMeta({ class: "administrative" })).toEqual({ "anthropic/requiresUserInteraction": true })
    expect(REQUIRES_USER_INTERACTION).toBe("anthropic/requiresUserInteraction")
    for (const writeClass of ["read", "add", "idempotent", "overwrite"] as const) {
      expect(toolMeta({ class: writeClass })).toBeUndefined()
    }
  })
})

describe("confirmWrite", () => {
  const admin = { id: "github_repo_delete", class: "administrative" } as const

  test("with no hook, the harness approved", async () => {
    await confirmWrite(admin, {}, "Delete octo/hello")
  })

  test("an accept lets the call go on, and the hook sees the tool and message", async () => {
    const requests: unknown[] = []
    await confirmWrite(
      admin,
      {
        confirm: async (request) => {
          requests.push(request)
          return true
        },
      },
      "Delete octo/hello",
    )
    expect(requests).toEqual([{ tool: "github_repo_delete", message: "Delete octo/hello" }])
  })

  test.each([false, undefined, "yes", 1])("anything but true (%p) is declined", async (answer) => {
    const error = await thrown(confirmWrite(admin, { confirm: async () => answer as boolean }, "Delete octo/hello"))
    expect(isToolError(error) && error.code).toBe("declined")
    expect((error as Error).message).toContain("Delete octo/hello")
  })

  test("a failing hook's error passes through", async () => {
    const failure = new Error("elicitation broke")
    const error = await thrown(
      confirmWrite(
        admin,
        {
          confirm: async () => {
            throw failure
          },
        },
        "m",
      ),
    )
    expect(error).toBe(failure)
  })

  test("other classes never ask", async () => {
    let asked = false
    const confirm = async () => {
      asked = true
      return false
    }
    for (const writeClass of ["read", "add", "idempotent", "overwrite"] as const) {
      await confirmWrite({ id: "github_issue_edit", class: writeClass }, { confirm }, "m")
    }
    expect(asked).toBe(false)
  })
})

describe("selectTools", () => {
  const all = [
    spec("github_issue_read", "issues", "read"),
    spec("github_issue_create", "issues", "add"),
    spec("github_pr_read", "pull_requests", "read"),
    spec("github_pr_merge", "pull_requests", "administrative"),
    spec("github_project_read", "projects", "read"),
    spec("github_project_item_add", "projects", "add"),
    spec("github_release_create", "releases", "add"),
  ]
  const ids = (settings?: Parameters<typeof selectTools>[1]) => selectTools(all, settings).map((s) => s.id)

  test("defaults to issues and pull_requests", () => {
    expect(DEFAULT_TOOLSETS).toEqual(["issues", "pull_requests"])
    expect(ids()).toEqual(["github_issue_read", "github_issue_create", "github_pr_read", "github_pr_merge"])
  })

  test('"all" turns on every toolset', () => {
    expect(ids({ toolsets: "all" })).toEqual(all.map((s) => s.id))
  })

  test("an explicit list replaces the default", () => {
    expect(ids({ toolsets: ["projects"] })).toEqual(["github_project_read", "github_project_item_add"])
  })

  test("an empty toolsets list means the default toolsets, like an absent one", () => {
    expect(ids({ toolsets: [] })).toEqual(ids())
    expect(ids({ toolsets: [] })).toEqual(ids({ toolsets: undefined }))
    expect(ids({ toolsets: [], tools: ["github_project_read"] })).toContain("github_project_read")
    expect(ids({ toolsets: [], read_only: true })).toEqual(["github_issue_read", "github_pr_read"])
  })

  test("tools adds single tools across toolsets", () => {
    expect(ids({ tools: ["github_release_create"] })).toContain("github_release_create")
    expect(ids({ toolsets: ["projects"], tools: ["github_release_create"] })).toEqual([
      "github_project_read",
      "github_project_item_add",
      "github_release_create",
    ])
  })

  test("exclude_tools removes, and wins over tools and toolsets", () => {
    expect(ids({ exclude_tools: ["github_pr_merge"] })).not.toContain("github_pr_merge")
    expect(ids({ tools: ["github_release_create"], exclude_tools: ["github_release_create"] })).not.toContain(
      "github_release_create",
    )
  })

  test("read_only drops every non-read tool and wins over tools", () => {
    expect(ids({ read_only: true })).toEqual(["github_issue_read", "github_pr_read"])
    expect(ids({ read_only: true, tools: ["github_release_create", "github_project_read"] })).toEqual([
      "github_issue_read",
      "github_pr_read",
      "github_project_read",
    ])
  })

  test("keeps the order of the full list", () => {
    expect(ids({ toolsets: ["pull_requests", "issues"] })).toEqual(ids())
  })

  test("an unknown toolset is invalid_argument naming it", () => {
    const error = (() => {
      try {
        selectTools(all, { toolsets: ["issues", "nope" as Toolset] })
      } catch (e) {
        return e
      }
    })()
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("nope")
    for (const name of TOOLSETS) expect((error as Error).message).toContain(name)
  })

  test("an unknown tool id in tools or exclude_tools is invalid_argument naming it", () => {
    for (const settings of [{ tools: ["github_nope_read"] }, { exclude_tools: ["github_nope_read"] }]) {
      try {
        selectTools(all, settings)
        throw new Error("expected selectTools to throw")
      } catch (error) {
        expect(isToolError(error) && error.code).toBe("invalid_argument")
        expect((error as Error).message).toContain("github_nope_read")
      }
    }
  })

  test("duplicate ids are a plain Error", () => {
    try {
      selectTools([all[0]!, all[0]!])
      throw new Error("expected selectTools to throw")
    } catch (error) {
      expect(isToolError(error)).toBe(false)
      expect((error as Error).message).toContain("github_issue_read")
    }
  })
})
