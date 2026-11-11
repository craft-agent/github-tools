import { tool as hostTool } from "@opencode-ai/plugin"
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "../core"
import { tempRepo } from "../testing/git-repo"
import { ADD_ID, ADMIN_ID, FAILING_ID, LABEL_ID, PROFILE, READ_ID, fixtureSpecs } from "./testing"
import type { V1AskRequest, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Fake = {
  options?: Record<string, unknown>
  env?: Record<string, string | undefined>
  ownDir?: string
  deny?: Error
}

async function setUp(fake: Fake = {}) {
  const events: string[] = []
  const asks: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project/sub",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asks.push(request)
      events.push(`ask:${request.permission}`)
      if (fake.deny) throw fake.deny
    },
  }
  const { tool } = await createV1Server(fixtureSpecs(events), { env: fake.env ?? {}, ownDir: fake.ownDir })(
    {},
    fake.options,
  )
  return { tool, asks, events, context }
}

describe("V1 server", () => {
  test("registers the default toolsets with the spec's description and argument shape", async () => {
    const { tool } = await setUp()
    expect(Object.keys(tool)).toEqual([READ_ID, ADD_ID, LABEL_ID, FAILING_ID])
    expect(tool[READ_ID]!.description).toBe(
      `Description of ${READ_ID}\n\nArguments:\n- repo (string, optional): The repository, as owner/name.\n- count (integer, optional): How many.`,
    )
    expect(Object.keys(tool[READ_ID]!.args)).toEqual(["repo", "count"])
    expect(z.object(tool[READ_ID]!.args).parse({ count: 1 })).toEqual({ count: 1 })
  })

  test("takes toolsets, read_only and tools from the options", async () => {
    expect(Object.keys((await setUp({ options: { toolsets: "all" } })).tool)).toContain(ADMIN_ID)
    expect(Object.keys((await setUp({ options: { read_only: true } })).tool)).toEqual([READ_ID])
    expect(Object.keys((await setUp({ options: { exclude_tools: [ADD_ID] } })).tool)).toEqual([
      READ_ID,
      LABEL_ID,
      FAILING_ID,
    ])
    expect(Object.keys((await setUp({ env: { GITHUB_TOOLS_TOOLSETS: "releases" } })).tool)).toEqual([ADMIN_ID])
  })

  // Validation crosses, JSON Schema only partly: `.describe()` writes to the registry of the Zod copy that made the
  // schema and the host's Zod 4.1.8 keeps its own, so its JSON Schema has the fields but not our descriptions, and
  // `.int()` reads as `number` there (the check still rejects 2.5).
  test("the argument shape works in the host's own Zod: it parses, rejects and lists its fields", async () => {
    const { tool } = await setUp()
    const host = hostTool.schema
    const args = host.object(tool[READ_ID]!.args)
    expect(args.parse({ repo: "octo/hello", count: 2 })).toEqual({ repo: "octo/hello", count: 2 })
    expect(args.safeParse({ count: "2" }).success).toBe(false)
    expect(args.safeParse({ repo: 5 }).success).toBe(false)
    expect(args.safeParse({ count: 2.5 }).success).toBe(false)

    const schema = host.toJSONSchema(args) as {
      properties: Record<string, { type: string; description?: string }>
    }
    expect(schema.properties.repo).toMatchObject({ type: "string" })
    expect(schema.properties.count).toMatchObject({ type: "number" })
  })

  test("rejects an unknown toolset and a wrong option type", async () => {
    await expect(setUp({ options: { toolsets: ["bogus"] } })).rejects.toThrow('Unknown toolset "bogus"')
    await expect(setUp({ options: { read_only: "yes" } })).rejects.toThrow('Option "read_only"')
  })
})

describe("V1 tool descriptions", () => {
  const spec = (id: string, input: z.ZodObject<any>) =>
    defineTool({
      id,
      title: id,
      description: "Does a thing.",
      toolset: "alpha",
      class: "read",
      input,
      output: z.object({}),
      async execute() {
        return {}
      },
    })

  const deps = { env: {}, profile: PROFILE }

  test("lists each argument with its type, optionality and description, in schema order", async () => {
    const { tool } = await createV1Server(
      [
        spec(
          "demo_thing_read",
          z.object({
            thing: z.string().describe("The thing,\n  as a number or URL."),
            state: z.enum(["open", "closed"]).describe("Which things.").optional(),
            limit: z.number().int().describe("How many.").optional(),
            labels: z.array(z.string()).describe("Labels to match.").optional(),
            ids: z.array(z.number().int()).optional(),
            extra: z.object({ a: z.string() }).optional(),
            anything: z.unknown().optional(),
          }),
        ),
      ],
      deps,
    )({}, {})
    expect(tool.demo_thing_read!.description).toBe(
      [
        "Does a thing.",
        "",
        "Arguments:",
        "- thing (string): The thing, as a number or URL.",
        "- state (open | closed, optional): Which things.",
        "- limit (integer, optional): How many.",
        "- labels (array of string, optional): Labels to match.",
        "- ids (array of integer, optional)",
        "- extra (object, optional)",
        "- anything (any, optional)",
      ].join("\n"),
    )
  })

  test("adds no section to a tool without arguments", async () => {
    const { tool } = await createV1Server([spec("demo_thing_read", z.object({}))], deps)({}, {})
    expect(tool.demo_thing_read!.description).toBe("Does a thing.")
  })
})

describe("V1 tool calls", () => {
  test("a read tool never asks, runs in the worktree and returns a JSON string", async () => {
    const { tool, asks, events, context } = await setUp()
    const result = await tool[READ_ID]!.execute({ count: 2 }, context)
    expect(result).toBe(JSON.stringify({ tool: READ_ID, cwd: "/work/project", count: 2 }))
    expect(asks).toEqual([])
    expect(events).toEqual([`execute:${READ_ID}`])
  })

  test("runs in the directory when there is no worktree", async () => {
    const { tool, context } = await setUp()
    const result = await tool[READ_ID]!.execute({}, { ...context, worktree: "" })
    expect(JSON.parse(result)).toEqual({ tool: READ_ID, cwd: "/work/project/sub" })
  })

  test("runs in the directory when the project is outside git and the worktree is /", async () => {
    const { tool, context } = await setUp()
    const result = await tool[READ_ID]!.execute({}, { ...context, worktree: "/" })
    expect(JSON.parse(result)).toEqual({ tool: READ_ID, cwd: "/work/project/sub" })
  })

  test("a write tool asks with its id as the permission and the repo as the pattern, before it runs", async () => {
    const { tool, asks, events, context } = await setUp()
    await tool[ADD_ID]!.execute({ repo: "octo/hello" }, context)
    expect(events).toEqual([`ask:${ADD_ID}`, `execute:${ADD_ID}`])
    expect(asks).toEqual([
      {
        permission: ADD_ID,
        patterns: ["octo/hello"],
        always: ["octo/hello"],
        metadata: {
          arguments: { repo: "octo/hello" },
          class: "add",
          message: `Title of ${ADD_ID}\n\n--- Details ---\n\nTarget: octo/hello`,
        },
      },
    ])
  })

  test("a described write tool shows its headline, facts and text without changing its permission targets", async () => {
    const { tool, asks, events, context } = await setUp()
    await tool[LABEL_ID]!.execute({ repo: "Octo/Hello" }, context)
    expect(events).toEqual([`ask:${LABEL_ID}`, `execute:${LABEL_ID}`])
    expect(asks).toEqual([
      {
        permission: LABEL_ID,
        patterns: ["octo/hello"],
        always: ["octo/hello"],
        metadata: {
          arguments: { repo: "Octo/Hello" },
          class: "add",
          message:
            'Label the repository "Octo/Hello"\n\n--- Details ---\n\nTarget: octo/hello\nRepository: Octo/Hello\n\n--- Body ---\n\nBody<U+202E>',
        },
      },
    ])
  })

  test("the pattern is the lowercased repository, and administrative tools ask too", async () => {
    const { tool, asks, context } = await setUp({ options: { toolsets: "all" } })
    await tool[ADMIN_ID]!.execute({ repo: "Octo/Hello" }, context)
    expect(asks.map((request) => [request.permission, request.patterns, request.always])).toEqual([
      [ADMIN_ID, ["octo/hello"], ["octo/hello"]],
    ])
  })

  test("a call whose targets cannot be told shows its title alone", async () => {
    const { tool, asks, context } = await setUp()
    await expect(tool[ADD_ID]!.execute({ repo: 5 }, context)).rejects.toThrow("invalid_argument")
    expect(asks[0]!.metadata.message).toBe(`Title of ${ADD_ID}`)
  })

  test("the install directory is handed to the tool, and a bare number there asks for *", async () => {
    const repo = tempRepo("git@github.com:Octo/Self.git")
    cleanups.push(repo.cleanup)
    const { tool, asks, context } = await setUp({ ownDir: repo.dir })
    const inInstallDir = { ...context, worktree: repo.dir }
    expect(JSON.parse(await tool[READ_ID]!.execute({}, inInstallDir)).own_dir).toBe(repo.dir)
    expect(JSON.parse(await tool[ADD_ID]!.execute({ issue: "3" }, inInstallDir)).own_dir).toBe(repo.dir)
    expect(asks.map((request) => request.patterns)).toEqual([["*"]])
  })

  test("a denial stops the call and surfaces the harness's error", async () => {
    const denial = new Error("The user rejected this call.")
    const { tool, events, context } = await setUp({ deny: denial })
    await expect(tool[ADD_ID]!.execute({}, context)).rejects.toBe(denial)
    expect(events).toEqual([`ask:${ADD_ID}`])
  })

  test("a tool failure reaches the harness as an Error reading <code>: <message>", async () => {
    const { tool, context } = await setUp()
    const failure = await tool[FAILING_ID]!.execute({}, context).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("not_found: No such issue.")
  })

  test("re-validates the arguments strictly", async () => {
    const { tool, context } = await setUp()
    await expect(tool[READ_ID]!.execute({ extra: 1 }, context)).rejects.toThrow(
      "invalid_argument: Invalid arguments for github_issue_read: extra: unknown argument",
    )
  })
})
