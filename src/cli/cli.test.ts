import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError, abortError, annotations, defineTool, selectTools, type ToolSpec } from "../core"
import { tempRepo } from "../testing/git-repo"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from "./cli"

const input = z.object({
  repo: z.string().describe("The repository, as owner/name.").optional(),
  count: z.number().int().optional(),
})
const output = z.object({
  tool: z.string(),
  cwd: z.string(),
  count: z.number().optional(),
  own_dir: z.string().optional(),
})
const writeInput = input.extend({ issue: z.string().optional(), parent: z.string().optional() })

const READ_ID = "github_issue_read"
const ADD_ID = "github_issue_comment"
const ADMIN_ID = "github_release_publish"
const MISSING_ID = "github_issue_close"
const BROKEN_ID = "github_issue_reopen"
const SLOW_ID = "github_issue_lock"
const DETAILED_ID = "github_issue_validate"
const DESCRIBED_ID = "github_issue_label"
const HANGING_DESCRIBE_ID = "github_issue_pin"

function fixture(id: string, toolset: ToolSpec["toolset"], writeClass: ToolSpec["class"]): ToolSpec {
  return defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    ...(id === ADD_ID && { targets: { issue: "issue", repo: "repo", parent: "issue" } as const }),
    input: id === ADD_ID ? writeInput : input,
    output,
    async execute(args, ctx) {
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

function failingWith(id: string, writeClass: ToolSpec["class"], fail: (signal?: AbortSignal) => Promise<never>) {
  return defineTool({
    id,
    title: id,
    description: id,
    toolset: "issues",
    class: writeClass,
    input,
    output,
    execute: (_args, ctx) => fail(ctx.signal),
  })
}

function describing(id: string, describe: ToolSpec["describe"]): ToolSpec {
  return defineTool({
    id,
    title: id,
    description: id,
    toolset: "issues",
    class: "add",
    targets: { repo: "repo" },
    input,
    output,
    describe,
    async execute(args, ctx) {
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

const specs: ToolSpec[] = [
  fixture(READ_ID, "issues", "read"),
  fixture(ADD_ID, "issues", "add"),
  fixture(ADMIN_ID, "releases", "administrative"),
  failingWith(MISSING_ID, "overwrite", async () => {
    throw new ToolError("not_found", "No such issue.")
  }),
  failingWith(BROKEN_ID, "overwrite", async () => {
    throw new TypeError("boom")
  }),
  failingWith(SLOW_ID, "idempotent", (signal) => {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(abortError(signal))
      signal?.addEventListener("abort", () => reject(abortError(signal)))
    })
  }),
  failingWith(DETAILED_ID, "overwrite", async () => {
    throw new ToolError("invalid_argument", "The thing has problems.", {
      details: { problems: [{ field: "name", reason: "empty" }] },
    })
  }),
  describing(DESCRIBED_ID, (args) => ({
    headline: { text: "Label the repository {repo}", values: { repo: String(args.repo ?? "here") } },
    facts: [{ label: "Repository", value: String(args.repo ?? "here") }],
    text: { label: "Body", body: "Body\u202E line\r\nnext" },
  })),
  describing(HANGING_DESCRIBE_ID, () => new Promise(() => {})),
]

type Run = { code: number; stdout: string; stderr: string }

async function cli(argv: string[], stdin = "", overrides: Partial<CliIo> = {}): Promise<Run> {
  let stdout = ""
  let stderr = ""
  const code = await runCli(argv, {
    specs,
    env: {},
    readStdin: async () => stdin,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...overrides,
  })
  return { code, stdout, stderr }
}

const json = (run: Run): any => JSON.parse(run.stdout)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("list", () => {
  test("describes the tools the settings select, in order", async () => {
    const run = await cli(["list"])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    const listed = json(run)
    expect(listed.map((entry: { id: string }) => entry.id)).toEqual(selectTools(specs, {}).map((spec) => spec.id))
    expect(listed[0]).toEqual({
      id: READ_ID,
      title: `Title of ${READ_ID}`,
      description: `Description of ${READ_ID}`,
      toolset: "issues",
      class: "read",
      annotations: annotations(specs[0]!),
      input_schema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        properties: expect.objectContaining({ repo: expect.objectContaining({ description: expect.any(String) }) }),
      }),
      output_schema: expect.objectContaining({ type: "object" }),
    })
  })

  test("follows the settings flags", async () => {
    const ids = async (...flags: string[]) =>
      json(await cli(["list", ...flags])).map((entry: { id: string }) => entry.id)
    expect(await ids("--toolsets", "all")).toContain(ADMIN_ID)
    expect(await ids("--toolsets=releases")).toEqual([ADMIN_ID])
    expect(await ids("--toolsets", "all", "--read-only")).toEqual([READ_ID])
    expect(await ids("--tools", ADMIN_ID, "--exclude-tools", READ_ID)).toEqual([
      ADD_ID,
      ADMIN_ID,
      MISSING_ID,
      BROKEN_ID,
      SLOW_ID,
      DETAILED_ID,
      DESCRIBED_ID,
      HANGING_DESCRIBE_ID,
    ])
    expect(await ids("--exclude-tools", `${READ_ID},${ADD_ID}`)).toEqual([
      MISSING_ID,
      BROKEN_ID,
      SLOW_ID,
      DETAILED_ID,
      DESCRIBED_ID,
      HANGING_DESCRIBE_ID,
    ])
  })

  test("reads the environment behind the flags", async () => {
    const run = await cli(["list"], "", { env: { GITHUB_TOOLS_TOOLSETS: "releases" } })
    expect(json(run).map((entry: { id: string }) => entry.id)).toEqual([ADMIN_ID])
  })

  test("lists nothing as an empty array", async () => {
    expect(json(await cli(["list", "--toolsets", "projects"]))).toEqual([])
  })
})

describe("run", () => {
  test("passes the arguments from stdin and the directory, and answers with the result", async () => {
    const run = await cli(["run", ADD_ID, "--cwd", "/work/tree"], JSON.stringify({ count: 3 }))
    expect(run).toEqual({
      code: EXIT_OK,
      stdout: `${JSON.stringify({ result: { tool: ADD_ID, cwd: "/work/tree", count: 3 } })}\n`,
      stderr: "",
    })
  })

  test("hands the install directory to the tool", async () => {
    const run = await cli(["run", ADD_ID, "--cwd", "/work/tree"], "", { ownDir: "/opt/github-tools" })
    expect(json(run).result).toEqual({ tool: ADD_ID, cwd: "/work/tree", own_dir: "/opt/github-tools" })
  })

  test("takes --cwd after the settings flags and in its --cwd=dir form", async () => {
    const run = await cli(["run", ADMIN_ID, "--toolsets", "all", "--cwd=/x"])
    expect(json(run)).toEqual({ result: { tool: ADMIN_ID, cwd: "/x" } })
  })

  test("empty stdin is an empty object", async () => {
    expect(json(await cli(["run", READ_ID, "--cwd", "/x"], "  \n")).result.tool).toBe(READ_ID)
  })

  test("maps a tool failure to its code and message", async () => {
    const run = await cli(["run", MISSING_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run)).toEqual({ error: { code: "not_found", message: "No such issue." } })
  })

  test("maps a tool failure with details to code, message and details", async () => {
    const run = await cli(["run", DETAILED_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run)).toEqual({
      error: {
        code: "invalid_argument",
        message: "The thing has problems.",
        details: { problems: [{ field: "name", reason: "empty" }] },
      },
    })
  })

  test("rejects arguments the schema does not accept", async () => {
    const run = await cli(["run", READ_ID, "--cwd", "/x"], JSON.stringify({ bogus: 1 }))
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
    expect(json(run).error.message).toContain("bogus")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["run", READ_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("an unknown tool, and one the settings leave out, are invalid_argument", async () => {
    for (const argv of [
      ["run", "github_nonexistent_read", "--cwd", "/x"],
      ["run", ADMIN_ID, "--cwd", "/x"],
      ["run", ADD_ID, "--cwd", "/x", "--read-only"],
    ]) {
      const run = await cli(argv)
      expect(run.code).toBe(EXIT_FAILED)
      expect(json(run).error.code).toBe("invalid_argument")
      expect(json(run).error.message).toContain(argv[1]!)
    }
  })

  test("an unexpected error is generic on stdout and detailed on stderr", async () => {
    const run = await cli(["run", BROKEN_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("github_error")
    expect(json(run).error.message).not.toContain("boom")
    expect(run.stderr).toContain("boom")
  })

  test("stops a running tool when the signal aborts", async () => {
    const controller = new AbortController()
    const pending = cli(["run", SLOW_ID, "--cwd", "/x"], "", { signal: controller.signal })
    controller.abort()
    const run = await pending
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("github_error")
    expect(json(run).error.message).toContain("cancelled")
  })
})

describe("target", () => {
  test("includes the call's description with hidden characters marked and newlines normalized", async () => {
    const run = await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"repo":"Octo/Hello"}')
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual({
      resources: ["octo/hello"],
      description: {
        headline: 'Label the repository "Octo/Hello"',
        facts: [{ label: "Repository", value: "Octo/Hello" }],
        text: { label: "Body", body: "Body<U+202E> line\nnext" },
      },
    })
  })

  test("still answers resources without a description when describing never settles", async () => {
    const run = await cli(["target", HANGING_DESCRIBE_ID, "--cwd", "/x"], '{"repo":"Octo/Hello"}', {
      describeTimeoutMs: 50,
    })
    expect(run).toEqual({ code: EXIT_OK, stdout: '{"resources":["octo/hello"]}\n', stderr: "" })
  })

  test("omits the description and answers * for invalid arguments", async () => {
    expect(json(await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"repo":3}'))).toEqual({ resources: ["*"] })
    expect(json(await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"bogus":1}'))).toEqual({ resources: ["*"] })
  })

  test("is the lowercased repo argument", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], JSON.stringify({ repo: "Octo/Hello" }))
    expect(run).toEqual({ code: EXIT_OK, stdout: '{"resources":["octo/hello"]}\n', stderr: "" })
  })

  test("is the working tree's origin without a repo argument", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir]))).toEqual({ resources: ["octo/hello"] })
  })

  test("is the repository a qualified issue names, not the working tree's", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const stdin = JSON.stringify({ issue: "Other/Repo#4", body: "x" })
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], stdin))).toEqual({ resources: ["other/repo"] })
  })

  test("lists every repository the call writes to", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const stdin = JSON.stringify({ issue: "4", parent: "Other/Repo#2" })
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], stdin))).toEqual({
      resources: ["octo/hello", "other/repo"],
    })
  })

  test("is * when the repository cannot be resolved", async () => {
    const repo = tempRepo()
    cleanups.push(repo.cleanup)
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir]))).toEqual({ resources: ["*"] })
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], '{"repo":"not a repo"}'))).toEqual({
      resources: ["*"],
    })
    expect(json(await cli(["target", ADD_ID, "--cwd", repo.dir], '{"repo":3}'))).toEqual({ resources: ["*"] })
  })

  test("is * for a bare number in the install directory, and still names a qualified issue there", async () => {
    const repo = tempRepo("git@github.com:Octo/Self.git")
    cleanups.push(repo.cleanup)
    const argv = ["target", ADD_ID, "--cwd", repo.dir]
    expect(json(await cli(argv, '{"issue":"3"}', { ownDir: repo.dir }))).toEqual({ resources: ["*"] })
    expect(json(await cli(argv, '{"issue":"o/r#3"}', { ownDir: repo.dir }))).toEqual({ resources: ["o/r"] })
    expect(json(await cli(argv, '{"issue":"3"}'))).toEqual({ resources: ["octo/self"] })
  })

  test("an unknown tool is invalid_argument", async () => {
    const run = await cli(["target", "github_nonexistent_read", "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })
})

describe("usage", () => {
  test.each([
    [[], "No command given"],
    [["bogus"], 'Unknown command "bogus"'],
    [["list", "--confirm", "harness"], "--confirm"],
    [["list", "--confirm=elicitation"], "--confirm"],
    [["list", "--nope"], "--nope"],
    [["list", "--toolsets", "bogus"], "bogus"],
    [["list", "--tools", "github_nonexistent_read"], "github_nonexistent_read"],
    [["list", ADD_ID], ADD_ID],
    [["run"], "needs a tool id"],
    [["run", "--cwd", "/x"], "needs a tool id"],
    [["run", ADD_ID], "--cwd"],
    [["run", ADD_ID, "--cwd"], "--cwd"],
    [["run", ADD_ID, "--cwd", "--read-only"], "--cwd"],
    [["run", ADD_ID, "--cwd="], "--cwd"],
    [["run", ADD_ID, "--cwd", "/x", "--confirm", "harness"], "--confirm"],
    [["target", ADD_ID], "--cwd"],
    [["target", ADD_ID, "--cwd", "/x", "--read-only"], "--read-only"],
  ])("%j is one line on stderr, exit 2 and nothing on stdout", async (argv, message) => {
    const run = await cli(argv as string[])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stdout).toBe("")
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(run.stderr).toContain(message)
  })

  test("ignores GITHUB_TOOLS_CONFIRM", async () => {
    expect((await cli(["list"], "", { env: { GITHUB_TOOLS_CONFIRM: "ask" } })).code).toBe(EXIT_OK)
  })
})
