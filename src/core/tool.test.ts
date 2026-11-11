import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { PROJECT_PROFILE } from "../entry/profile"
import { PROJECT } from "../project"
import { ToolError, isToolError } from "./errors"
import {
  REQUIRES_USER_INTERACTION,
  StepErrors,
  annotations,
  confirmWrite,
  defineTool,
  inputJsonSchema,
  invoke,
  outputJsonSchema,
  selectTools,
  toolMeta,
  type ToolContext,
  type ToolSpec,
  type WriteClass,
} from "./tool"

const input = z.object({ count: z.number().int(), label: z.string().optional() })
const output = z.object({ total: z.number() })

function spec(id: string, toolset: string, writeClass: WriteClass): ToolSpec {
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

  test.each(["demo_thing_create", "demo_thing_item_add", "demo_thing_read", "a_b_c"])("accepts %s", (id) => {
    expect(() => defineTool({ ...base, id })).not.toThrow()
  })

  test.each([
    "thing_create",
    "demo_thing",
    "demo",
    "demo_Thing_create",
    "demo_thing_create2",
    "demo__thing_create",
    "demo_thing-create",
    "_demo_thing_create",
    "demo_thing_create_",
  ])("rejects the id %s", (id) => {
    expect(() => defineTool({ ...base, id })).toThrow(/<prefix>_<domain>_<verb>/)
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

  test("rejects an output schema that is not an object", () => {
    const given = { ...base, id: "github_issue_create", output: z.array(z.string()) }
    expect(() => defineTool(given as unknown as Parameters<typeof defineTool>[0])).toThrow(/object output schema/)
  })

  test("accepts an intent that is a fixed phrase", () => {
    expect(() => defineTool({ ...base, id: "github_issue_create", intent: "About to create an issue" })).not.toThrow()
  })

  test.each(["", "   "])("rejects the blank intent %j", (intent) => {
    expect(() => defineTool({ ...base, id: "github_issue_create", intent })).toThrow(/intent that is not blank/)
  })

  test.each(["About to create {name}", "About } to create", "About { to create"])("rejects the intent %j", (intent) => {
    expect(() => defineTool({ ...base, id: "github_issue_create", intent })).toThrow(/intent without braces/)
  })

  test("accepts targets that are arguments of the input and rejects any other", () => {
    const id = "github_issue_create"
    expect(() => defineTool({ ...base, id, targets: { label: "repo" } })).not.toThrow()
    expect(() => defineTool({ ...base, id, targets: { repo: "repo" } })).toThrow(
      /target "repo".*not one of its arguments/,
    )
    const inherited = JSON.parse('{"toString":"repo"}')
    expect(() => defineTool({ ...base, id, targets: inherited })).toThrow(/target "toString"/)
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
  const ids = (settings: Parameters<typeof selectTools>[1] = {}) =>
    selectTools(all, settings, PROJECT_PROFILE.toolsets).map((s) => s.id)

  test("defaults to issues, pull_requests and projects", () => {
    expect(PROJECT.defaultToolsets).toEqual(["issues", "pull_requests", "projects"])
    expect(ids()).toEqual([
      "github_issue_read",
      "github_issue_create",
      "github_pr_read",
      "github_pr_merge",
      "github_project_read",
      "github_project_item_add",
    ])
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
    expect(ids({ toolsets: [], tools: ["github_release_create"] })).toContain("github_release_create")
    expect(ids({ toolsets: [], read_only: true })).toEqual([
      "github_issue_read",
      "github_pr_read",
      "github_project_read",
    ])
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
    expect(ids({ read_only: true })).toEqual(["github_issue_read", "github_pr_read", "github_project_read"])
    expect(
      ids({ toolsets: ["issues"], read_only: true, tools: ["github_release_create", "github_project_read"] }),
    ).toEqual(["github_issue_read", "github_project_read"])
  })

  test("keeps the order of the full list", () => {
    expect(ids({ toolsets: ["projects", "pull_requests", "issues"] })).toEqual(ids())
  })

  test("an unknown toolset is invalid_argument naming it", () => {
    const error = (() => {
      try {
        selectTools(all, { toolsets: ["issues", "nope"] }, PROJECT_PROFILE.toolsets)
      } catch (e) {
        return e
      }
    })()
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("nope")
    for (const name of PROJECT.toolsets) expect((error as Error).message).toContain(name)
  })

  test("an unknown tool id in tools or exclude_tools is invalid_argument naming it", () => {
    for (const settings of [{ tools: ["github_nope_read"] }, { exclude_tools: ["github_nope_read"] }]) {
      try {
        selectTools(all, settings, PROJECT_PROFILE.toolsets)
        throw new Error("expected selectTools to throw")
      } catch (error) {
        expect(isToolError(error) && error.code).toBe("invalid_argument")
        expect((error as Error).message).toContain("github_nope_read")
      }
    }
  })

  test("duplicate ids are a plain Error", () => {
    try {
      selectTools([all[0]!, all[0]!], {}, PROJECT_PROFILE.toolsets)
      throw new Error("expected selectTools to throw")
    } catch (error) {
      expect(isToolError(error)).toBe(false)
      expect((error as Error).message).toContain("github_issue_read")
    }
  })
})

describe("invoke", () => {
  const tool = (execute: ToolSpec<typeof input, typeof output>["execute"]) =>
    defineTool({
      id: "github_issue_count",
      title: "Count",
      description: "d",
      toolset: "issues",
      class: "add",
      input,
      output,
      execute,
    })

  test("validates, executes and returns the parsed output", async () => {
    const seen: unknown[] = []
    const result = await invoke(
      tool(async (args, ctx) => {
        seen.push(args, ctx)
        return { total: args.count * 2 }
      }),
      { count: 21 },
      CTX,
    )
    expect(result).toEqual({ total: 42 })
    expect(seen).toEqual([{ count: 21 }, CTX])
  })

  test("bad arguments are invalid_argument listing path: message", async () => {
    const error = await thrown(
      invoke(
        tool(async () => ({ total: 1 })),
        { count: "x", label: 3 },
        CTX,
      ),
    )
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("github_issue_count")
    expect((error as Error).message).toContain("count: ")
    expect((error as Error).message).toContain("label: ")
  })

  test("arguments that are not an object are invalid_argument", async () => {
    const error = await thrown(
      invoke(
        tool(async () => ({ total: 1 })),
        null,
        CTX,
      ),
    )
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })

  test("execute does not run when the arguments are bad", async () => {
    let ran = false
    await thrown(
      invoke(
        tool(async () => {
          ran = true
          return { total: 1 }
        }),
        {},
        CTX,
      ),
    )
    expect(ran).toBe(false)
  })

  test("unknown arguments are invalid_argument naming each unknown key", async () => {
    let ran = false
    const error = await thrown(
      invoke(
        tool(async () => {
          ran = true
          return { total: 1 }
        }),
        { count: 1, extra: true, other: 2 },
        CTX,
      ),
    )
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("extra: unknown argument")
    expect((error as Error).message).toContain("other: unknown argument")
    expect(ran).toBe(false)
  })

  test("strict parsing does not change the spec's own schema", async () => {
    const spec = tool(async () => ({ total: 1 }))
    await thrown(invoke(spec, { count: 1, extra: true }, CTX))
    expect(spec.input.safeParse({ count: 1, extra: true }).success).toBe(true)
  })

  /** A tool whose `execute` returns whatever it is given, past the type checker. */
  const returning = (result: unknown) =>
    tool((async () => result) as unknown as ToolSpec<typeof input, typeof output>["execute"])

  test("a result that breaks the output schema is an internal_error carrying the raw result", async () => {
    const bad = returning({ total: "many", created: "https://github.com/o/r/issues/7" })
    const error = await thrown(invoke(bad, { count: 1 }, CTX))
    expect(isToolError(error) && error.code).toBe("internal_error")
    const message = (error as Error).message
    expect(message).toContain("github_issue_count returned a result that does not match its output schema")
    expect(message).toContain("total")
    expect(message).toContain('"created":"https://github.com/o/r/issues/7"')
  })

  test("the raw result in that message is capped", async () => {
    const error = await thrown(invoke(returning({ total: "x".repeat(10_000) }), { count: 1 }, CTX))
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect((error as Error).message.length).toBeLessThan(2600)
  })

  test("a result that cannot be serialized still reports internal_error", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const error = await thrown(invoke(returning(circular), { count: 1 }, CTX))
    expect(isToolError(error) && error.code).toBe("internal_error")
  })

  test("a ToolError from execute passes through unchanged", async () => {
    const failure = new ToolError("not_found", "no such issue")
    const error = await thrown(
      invoke(
        tool(async () => {
          throw failure
        }),
        { count: 1 },
        CTX,
      ),
    )
    expect(error).toBe(failure)
  })

  test("other errors, including aborts, pass through unchanged", async () => {
    const plain = new Error("boom")
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    for (const failure of [plain, abort]) {
      const error = await thrown(
        invoke(
          tool(async () => {
            throw failure
          }),
          { count: 1 },
          CTX,
        ),
      )
      expect(error).toBe(failure)
    }
  })
})

describe("JSON schemas", () => {
  const tool = defineTool({
    id: "github_issue_count",
    title: "Count",
    description: "d",
    toolset: "issues",
    class: "add",
    input: z.object({ count: z.number().int(), label: z.string().default("x") }),
    output,
    execute: async () => ({ total: 1 }),
  })

  test("input schema describes the arguments a caller sends", () => {
    const schema = inputJsonSchema(tool)
    expect(schema.type).toBe("object")
    expect(Object.keys(schema.properties ?? {})).toEqual(["count", "label"])
    expect(schema.required).toEqual(["count"])
  })

  test("output schema describes the result", () => {
    const schema = outputJsonSchema(tool)
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["total"])
  })
})

describe("StepErrors", () => {
  test("returns a step's value and records nothing", async () => {
    const steps = new StepErrors()
    expect(await steps.record("milestone", async () => 5)).toBe(5)
    expect(steps.any).toBe(false)
    expect(steps.errors).toEqual({})
  })

  test("a failing step yields undefined and is recorded, with the code of a ToolError", async () => {
    const steps = new StepErrors()
    expect(
      await steps.record("milestone", async () => {
        throw new ToolError("forbidden", "no access")
      }),
    ).toBeUndefined()
    expect(
      await steps.record("relation", async () => {
        throw new Error("plain failure")
      }),
    ).toBeUndefined()
    expect(steps.any).toBe(true)
    expect(steps.errors).toEqual({ milestone: "forbidden: no access", relation: "plain failure" })
  })

  test("later steps still run after a failure", async () => {
    const steps = new StepErrors()
    await steps.record("a", async () => {
      throw new Error("x")
    })
    expect(await steps.record("b", async () => "ok")).toBe("ok")
  })

  test("an AbortError is rethrown, never recorded", async () => {
    const steps = new StepErrors()
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const error = await thrown(
      steps.record("a", async () => {
        throw abort
      }),
    )
    expect(error).toBe(abort)
    expect(steps.any).toBe(false)
  })

  test("errors returns a copy", async () => {
    const steps = new StepErrors()
    await steps.record("a", async () => {
      throw new Error("x")
    })
    steps.errors.a = "changed"
    expect(steps.errors).toEqual({ a: "x" })
  })
})
