import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { REQUIRES_USER_INTERACTION, ToolError, annotations, defineTool, selectTools } from "../core"
import type { EntrySettings } from "../entry/settings"
import { PROJECT_PROFILE } from "../entry/profile"
import { ALL_TOOLS } from "../tools"
import { createServer } from "./server"
import {
  TOOLSETS,
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
    tool("demo_thing_read", "alpha", "read", calls),
    tool("demo_thing_create", "alpha", "add", calls),
    tool("demo_thing_label", "alpha", "idempotent", calls),
    tool("demo_thing_edit", "alpha", "overwrite", calls),
    tool("demo_other_read", "beta", "read", calls),
    tool("demo_other_delete", "beta", "administrative", calls),
  ]
  const names = async (entry: EntrySettings) => {
    const { client } = await connect(specs, entry)
    return (await client.listTools()).tools.map((t) => t.name)
  }

  test("follows selectTools: the default toolsets", async () => {
    expect(await names(settings())).toEqual(selectTools(specs, {}, TOOLSETS).map((s) => s.id))
    expect(await names(settings())).toEqual([
      "demo_thing_read",
      "demo_thing_create",
      "demo_thing_label",
      "demo_thing_edit",
    ])
  })

  test("follows selectTools: toolsets, read_only, tools and exclude_tools", async () => {
    for (const given of [
      { toolsets: "all" as const },
      { toolsets: "all" as const, read_only: true },
      { tools: ["demo_other_delete"] },
      { exclude_tools: ["demo_thing_edit"] },
      { toolsets: ["beta"], exclude_tools: ["demo_other_read"] },
    ]) {
      expect(await names(settings(given))).toEqual(selectTools(specs, given, TOOLSETS).map((s) => s.id))
    }
  })

  test("a server with no tool selected lists none", async () => {
    expect(
      await names(settings({ toolsets: ["beta"], exclude_tools: ["demo_other_read", "demo_other_delete"] })),
    ).toEqual([])
  })

  test("an unknown tool id in the settings fails createServer", () => {
    expect(() => createServer(specs, settings({ tools: ["demo_nope_read"] }), { toolsets: TOOLSETS })).toThrow(
      /demo_nope_read/,
    )
  })

  test("an unknown toolset in the settings fails createServer, naming the toolsets there are", () => {
    expect(() => createServer(specs, settings({ toolsets: ["gamma"] }), { toolsets: TOOLSETS })).toThrow(
      /"gamma".*alpha, beta/,
    )
  })

  test("a server built without toolsets knows the package's own", () => {
    expect(() => createServer([], settings({ toolsets: "all" }))).not.toThrow()
    expect(() => createServer([], settings({ toolsets: ["unknown-toolset"] }))).toThrow(/unknown-toolset/)
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

describe("the class of a tool", () => {
  const calls: Call[] = []

  test("a read tool stays under read_only, with read-only hints and no meta", async () => {
    for (const given of [{}, { read_only: true }]) {
      const { client } = await connect([tool("demo_thing_read", "alpha", "read", calls)], settings(given))
      const [listed] = (await client.listTools()).tools
      expect(listed!.annotations).toEqual({
        title: listed!.title!,
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      })
      expect(listed!._meta).toBeUndefined()
    }
  })

  test.each([
    ["add", { destructiveHint: false, idempotentHint: false }],
    ["idempotent", { destructiveHint: false, idempotentHint: true }],
    ["overwrite", { destructiveHint: true, idempotentHint: true }],
  ] as const)("a %s tool is a write tool, and read_only leaves it out", async (writeClass, hints) => {
    const specs = [tool("demo_thing_write", "alpha", writeClass, calls)]
    const [listed] = (await (await connect(specs, settings())).client.listTools()).tools
    expect(listed!.annotations).toEqual({ title: listed!.title!, readOnlyHint: false, ...hints, openWorldHint: true })
    expect(listed!._meta).toBeUndefined()

    const { client: readOnly } = await connect(specs, settings({ read_only: true }))
    expect((await readOnly.listTools()).tools).toEqual([])
  })
})

describe("the package's tools", () => {
  test("each is published with its class's annotations, an object output and a strict input", async () => {
    const { client } = await connect(
      ALL_TOOLS,
      settings({ toolsets: "all" }),
      {},
      { toolsets: PROJECT_PROFILE.toolsets },
    )
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((spec) => spec.id))
    for (const spec of ALL_TOOLS) {
      const listed = tools.find((t) => t.name === spec.id)!
      expect(listed.annotations).toEqual(annotations(spec))
      expect(listed.outputSchema?.type).toBe("object")
      expect(listed.inputSchema.additionalProperties).toBe(false)
    }
  })
})

describe("calls", () => {
  test("a result is structuredContent and the same JSON as text", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_issue_create", "alpha", "add", calls)], settings())
    const result = await call(client, "github_issue_create", { count: 3 })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ tool: "github_issue_create", count: 3 })
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent))
    expect(calls.map((c) => c.args)).toEqual([{ count: 3 }])
  })

  test("a ToolError is an error result carrying its code and message", async () => {
    const { client } = await connect(
      [failing("github_issue_missing_read", new ToolError("not_found", "No issue #9."))],
      settings(),
    )
    const result = await call(client, "github_issue_missing_read")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({ error: { code: "not_found", message: "No issue #9." } })
    expect(result.structuredContent).toBeUndefined()
  })

  test("a ToolError with details yields code, message and details", async () => {
    const details = { violations: [{ rule: "subject-max", line: 1 }] }
    const { client } = await connect(
      [failing("github_issue_invalid_read", new ToolError("invalid_argument", "Validation failed.", { details }))],
      settings(),
    )
    const result = await call(client, "github_issue_invalid_read")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: { code: "invalid_argument", message: "Validation failed.", details },
    })
    expect(result.structuredContent).toBeUndefined()
  })

  test("an unexpected error tells the client only to see the log, and the log gets the whole error", async () => {
    const failure = new Error("ENOENT: no such file '/Users/secret/project/.env'")
    const { client, logs } = await connect([failing("github_issue_broken_read", failure)], settings())
    const result = await call(client, "github_issue_broken_read")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: {
        code: "internal_error",
        message: "Unexpected error while running github_issue_broken_read; see the server log.",
      },
    })
    expect(textOf(result)).not.toContain("/Users/secret")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("github_issue_broken_read")
    expect(logs[0]).toContain("/Users/secret/project/.env")
    expect(logs[0]).toContain("    at ")
  })

  test("a thrown value that is not an Error is logged and hidden the same way", async () => {
    const { client, logs } = await connect(
      [
        defineTool({
          id: "github_issue_odd_read",
          title: "t",
          description: "d",
          toolset: "alpha",
          class: "read",
          input: toolInput,
          output: toolOutput,
          async execute() {
            throw "/etc/passwd"
          },
        }),
      ],
      settings(),
    )
    const result = await call(client, "github_issue_odd_read")
    expect(textOf(result)).not.toContain("/etc/passwd")
    expect(logs[0]).toContain("/etc/passwd")
  })

  test("an unknown tool is an invalid_argument error result", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_issue_create", "alpha", "add", calls)], settings())
    const result = await call(client, "github_nonexistent_read")
    expect(result.isError).toBe(true)
    const { error } = JSON.parse(textOf(result))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("github_nonexistent_read")
  })

  test("a tool the settings left out is unknown", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_repo_read", "beta", "read", calls)], settings())
    const result = await call(client, "github_repo_read")
    expect(JSON.parse(textOf(result)).error.code).toBe("invalid_argument")
    expect(calls).toEqual([])
  })

  test("an unknown argument is invalid_argument in our shape and execute never runs", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_issue_create", "alpha", "add", calls)], settings())
    const result = await call(client, "github_issue_create", { count: 1, extra: true })
    expect(result.isError).toBe(true)
    const { error } = JSON.parse(textOf(result))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("github_issue_create")
    expect(error.message).toContain("extra: unknown argument")
    expect(calls).toEqual([])
  })

  test("an argument of the wrong type is invalid_argument and execute never runs", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_issue_create", "alpha", "add", calls)], settings())
    const result = await call(client, "github_issue_create", { count: "x" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).error.code).toBe("invalid_argument")
    expect(calls).toEqual([])
  })

  test("a call without arguments runs with an empty object", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_issue_create", "alpha", "add", calls)], settings())
    const result = await client.callTool({ name: "github_issue_create" })
    expect(result.isError).toBeUndefined()
    expect(calls.map((c) => c.args)).toEqual([{}])
  })

  test("a transforming input schema is parsed once", async () => {
    const seen: unknown[] = []
    const { client } = await connect(
      [
        defineTool({
          id: "github_issue_double_read",
          title: "t",
          description: "d",
          toolset: "alpha",
          class: "read",
          input: z.object({ n: z.string().transform((s) => Number(s) * 2) }),
          output: z.object({ n: z.number() }),
          async execute(args) {
            seen.push(args)
            return { n: args.n }
          },
        }),
      ],
      settings(),
    )
    const result = await call(client, "github_issue_double_read", { n: "21" })
    expect(result.structuredContent).toEqual({ n: 42 })
    expect(seen).toEqual([{ n: 42 }])
  })

  test("the context carries an abort signal", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("github_issue_create", "alpha", "add", calls)], settings())
    await call(client, "github_issue_create")
    expect(calls[0]!.ctx.signal).toBeInstanceOf(AbortSignal)
  })
})
