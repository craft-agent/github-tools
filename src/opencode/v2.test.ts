import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { tempRepo } from "../testing/git-repo"
import { ADD_ID, ADMIN_ID, FAILING_ID, LABEL_ID, READ_ID, fixtureSpecs } from "./testing"
import type { V2Context, V2PermissionRequest, V2Skill, V2Tool } from "./types"
import { createV2Setup } from "./v2"

const SESSION_ID = "ses_1"
const DEFAULT_DIRECTORY = "/work/project"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type FakeOptions = {
  options?: Record<string, unknown>
  /** What `session.get` resolves to (a session in `/work/project` when absent); `null` makes it reject. */
  location?: { directory?: string } | null
  /** The `ownDir` the plugin is built with. */
  ownDir?: string
  /** Makes `permission.assert` reject with this error. */
  deny?: Error
  events?: string[]
}

function fakeContext(fake: FakeOptions = {}) {
  const events = fake.events ?? []
  const tools = new Map<string, V2Tool>()
  const skills: V2Skill[] = []
  const asserts: V2PermissionRequest[] = []
  const ctx: V2Context = {
    options: fake.options,
    session: {
      async get() {
        if (fake.location === null) throw new Error("no such session")
        return { location: fake.location ?? { directory: DEFAULT_DIRECTORY } }
      },
    },
    permission: {
      async assert(input) {
        asserts.push(input)
        events.push(`assert:${input.action}`)
        if (fake.deny) throw fake.deny
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async (callback) => callback({ add: (skill) => skills.push(skill) }) },
  }
  return { ctx, tools, skills, asserts, events }
}

async function setUp(fake: FakeOptions = {}, env: Record<string, string | undefined> = {}) {
  const events = fake.events ?? []
  const fakeCtx = fakeContext({ ...fake, events })
  await createV2Setup(fixtureSpecs(events), { env, ownDir: fake.ownDir })(fakeCtx.ctx)
  return fakeCtx
}

const signal = new AbortController().signal

describe("V2 setup", () => {
  test("registers the default toolsets with the spec's name, description and schemas", async () => {
    const { tools } = await setUp()
    expect([...tools.keys()]).toEqual([READ_ID, ADD_ID, LABEL_ID, FAILING_ID])
    const read = tools.get(READ_ID)!
    expect(read.description).toBe(`Description of ${READ_ID}`)
    expect(z.toJSONSchema(read.input, { io: "input" }).additionalProperties).toBe(false)
    expect(Object.keys(read.input.shape)).toEqual(["repo", "count"])
    expect(Object.keys(read.output.shape)).toEqual(["tool", "cwd", "count", "own_dir"])
  })

  test("takes toolsets, read_only and tools from the options", async () => {
    expect([...(await setUp({ options: { toolsets: "all" } })).tools.keys()]).toContain(ADMIN_ID)
    expect([...(await setUp({ options: { toolsets: ["releases"] } })).tools.keys()]).toEqual([ADMIN_ID])
    expect([...(await setUp({ options: { read_only: true, toolsets: "all" } })).tools.keys()]).toEqual([READ_ID])
    expect([...(await setUp({ options: { tools: [ADMIN_ID], exclude_tools: [ADD_ID] } })).tools.keys()]).toEqual([
      READ_ID,
      LABEL_ID,
      ADMIN_ID,
      FAILING_ID,
    ])
  })

  test("falls back to the environment, and an option wins over it", async () => {
    expect([...(await setUp({}, { GITHUB_TOOLS_READ_ONLY: "true" })).tools.keys()]).toEqual([READ_ID])
    expect([
      ...(await setUp({ options: { read_only: false } }, { GITHUB_TOOLS_READ_ONLY: "true" })).tools.keys(),
    ]).toEqual([READ_ID, ADD_ID, LABEL_ID, FAILING_ID])
  })

  test("rejects an unknown toolset, a wrong option type and an unknown option", async () => {
    await expect(setUp({ options: { toolsets: ["bogus"] } })).rejects.toThrow('Unknown toolset "bogus"')
    await expect(setUp({ options: { read_only: "yes" } })).rejects.toThrow('Option "read_only"')
    await expect(setUp({ options: { toolsets: 3 } })).rejects.toThrow('Option "toolsets"')
    await expect(setUp({ options: { tools: "github_issue_read" } })).rejects.toThrow('Option "tools"')
    await expect(setUp({ options: { exclude_tools: [1] } })).rejects.toThrow('Option "exclude_tools"')
    await expect(setUp({ options: { readonly: true } })).rejects.toThrow('Unknown option "readonly"')
    await expect(setUp({ options: { tools: ["github_nothing_read"] } })).rejects.toThrow("Unknown tool")
  })

  test("registers nothing when no tool is selected", async () => {
    const { tools } = await setUp({ options: { toolsets: ["releases"], exclude_tools: [ADMIN_ID] } })
    expect(tools.size).toBe(0)
  })
})

describe("V2 tool calls", () => {
  test("a read tool never asks, runs in the session's directory and returns content and output", async () => {
    const { tools, asserts, events } = await setUp({ location: { directory: "/work/project" } })
    const result = await tools.get(READ_ID)!.execute({ count: 2 }, { sessionID: SESSION_ID, signal })
    const output = { tool: READ_ID, cwd: "/work/project", count: 2 }
    expect(result).toEqual({ content: JSON.stringify(output), output })
    expect(asserts).toEqual([])
    expect(events).toEqual([`execute:${READ_ID}`])
  })

  test("a write tool asks with its id as the action and the repo as the resource, before it runs", async () => {
    const { tools, asserts, events } = await setUp({ location: { directory: "/work/project" } })
    await tools.get(ADD_ID)!.execute({ repo: "octo/hello", count: 1 }, { sessionID: SESSION_ID, signal })
    expect(events).toEqual([`assert:${ADD_ID}`, `execute:${ADD_ID}`])
    expect(asserts).toEqual([
      {
        action: ADD_ID,
        resources: ["octo/hello"],
        save: ["octo/hello"],
        metadata: {
          arguments: { repo: "octo/hello", count: 1 },
          class: "add",
          message: `Title of ${ADD_ID}\n\n--- Details ---\n\nTarget: octo/hello`,
        },
        sessionID: SESSION_ID,
      },
    ])
  })

  test("a described write tool shows its headline, facts and text without changing its permission targets", async () => {
    const { tools, asserts, events } = await setUp()
    await tools.get(LABEL_ID)!.execute({ repo: "Octo/Hello" }, { sessionID: SESSION_ID, signal })
    expect(events).toEqual([`assert:${LABEL_ID}`, `execute:${LABEL_ID}`])
    expect(asserts).toEqual([
      {
        action: LABEL_ID,
        resources: ["octo/hello"],
        save: ["octo/hello"],
        metadata: {
          arguments: { repo: "Octo/Hello" },
          class: "add",
          message:
            'Label the repository "Octo/Hello"\n\n--- Details ---\n\nTarget: octo/hello\nRepository: Octo/Hello\n\n--- Body ---\n\nBody<U+202E>',
        },
        sessionID: SESSION_ID,
      },
    ])
  })

  test("a describe that throws still asks with the title and the targets", async () => {
    const fake = fakeContext()
    const specs = fixtureSpecs(fake.events)
    specs.find((spec) => spec.id === LABEL_ID)!.describe = () => {
      throw new Error("cannot describe")
    }
    await createV2Setup(specs, { env: {} })(fake.ctx)
    await fake.tools.get(LABEL_ID)!.execute({ repo: "Octo/Hello" }, { sessionID: SESSION_ID, signal })
    expect(fake.asserts).toEqual([
      {
        action: LABEL_ID,
        resources: ["octo/hello"],
        save: ["octo/hello"],
        metadata: {
          arguments: { repo: "Octo/Hello" },
          class: "add",
          message: `Title of ${LABEL_ID}\n\n--- Details ---\n\nTarget: octo/hello`,
        },
        sessionID: SESSION_ID,
      },
    ])
    expect(fake.events).toEqual([`assert:${LABEL_ID}`, `execute:${LABEL_ID}`])
  })

  test("the resource is the lowercased repository, and administrative tools ask too", async () => {
    const { tools, asserts } = await setUp({ options: { toolsets: "all" }, location: { directory: "/work/project" } })
    await tools.get(ADMIN_ID)!.execute({ repo: "Octo/Hello" }, { sessionID: SESSION_ID, signal })
    expect(
      asserts.map((request) => [request.action, request.resources, request.save, request.metadata?.class]),
    ).toEqual([[ADMIN_ID, ["octo/hello"], ["octo/hello"], "administrative"]])
  })

  test("without a repo argument the resource is the session directory's origin repository", async () => {
    const repo = tempRepo("https://github.com/Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const { tools, asserts } = await setUp({ location: { directory: repo.dir } })
    await tools.get(ADD_ID)!.execute({}, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => request.resources)).toEqual([["octo/hello"]])
  })

  test("a qualified issue in another repository asks for that repository, not the session directory's", async () => {
    const repo = tempRepo("https://github.com/Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const { tools, asserts } = await setUp({ location: { directory: repo.dir } })
    await tools.get(ADD_ID)!.execute({ issue: "Other/Repo#4" }, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([[["other/repo"], ["other/repo"]]])
  })

  test("a call that writes to two repositories asks for both, and the message names each on a Target line", async () => {
    const repo = tempRepo("https://github.com/Octo/Hello.git")
    cleanups.push(repo.cleanup)
    const { tools, asserts } = await setUp({ location: { directory: repo.dir } })
    await tools.get(ADD_ID)!.execute({ issue: "3", branch_repo: "Fork/Hello" }, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([
      [
        ["fork/hello", "octo/hello"],
        ["fork/hello", "octo/hello"],
      ],
    ])
    expect(asserts[0]!.metadata?.message).toBe(
      `Title of ${ADD_ID}\n\n--- Details ---\n\nTarget: fork/hello\nTarget: octo/hello`,
    )
  })

  test("a call whose targets cannot be told shows its title alone", async () => {
    const { tools, asserts } = await setUp()
    await expect(tools.get(ADD_ID)!.execute({ repo: 5 }, { sessionID: SESSION_ID, signal })).rejects.toThrow(
      "invalid_argument",
    )
    expect(asserts[0]!.metadata?.message).toBe(`Title of ${ADD_ID}`)
  })

  test("the resource is * when the repository cannot be resolved, and an always answer saves nothing", async () => {
    const repo = tempRepo()
    cleanups.push(repo.cleanup)
    const { tools, asserts } = await setUp({ location: { directory: repo.dir } })
    await tools.get(ADD_ID)!.execute({}, { sessionID: SESSION_ID, signal })
    await tools.get(ADD_ID)!.execute({ repo: "not a repo" }, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([
      [["*"], []],
      [["*"], []],
    ])
  })

  test("a repository that cannot be told is asked for beside the others, and never saved", async () => {
    const repo = tempRepo()
    cleanups.push(repo.cleanup)
    const { tools, asserts } = await setUp({ location: { directory: repo.dir } })
    await tools.get(ADD_ID)!.execute({ issue: "a/b#1", branch_repo: "not a repo" }, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([[["a/b", "*"], ["a/b"]]])
  })

  test("the install directory is handed to the tool, and a bare number there asks for *", async () => {
    const repo = tempRepo("https://github.com/Octo/Self.git")
    cleanups.push(repo.cleanup)
    const { tools, asserts } = await setUp({ ownDir: repo.dir, location: { directory: repo.dir } })
    const read = await tools.get(READ_ID)!.execute({}, { sessionID: SESSION_ID, signal })
    const add = await tools.get(ADD_ID)!.execute({ issue: "3" }, { sessionID: SESSION_ID, signal })
    expect([read, add].map(({ output }) => (output as { own_dir?: string }).own_dir)).toEqual([repo.dir, repo.dir])
    expect(asserts.map((request) => request.resources)).toEqual([["*"]])
  })

  test("a denial stops the call and surfaces the harness's error", async () => {
    const denial = new Error("Permission denied: github_issue_comment")
    const { tools, events } = await setUp({ deny: denial })
    await expect(tools.get(ADD_ID)!.execute({}, { sessionID: SESSION_ID, signal })).rejects.toBe(denial)
    expect(events).toEqual([`assert:${ADD_ID}`])
  })

  test("a read tool falls back to the process directory when the session's directory cannot be read", async () => {
    const withoutLocation = await setUp({ location: {} })
    const missing = await setUp({ location: null })
    for (const { tools } of [withoutLocation, missing]) {
      const { output } = await tools.get(READ_ID)!.execute({}, { sessionID: SESSION_ID, signal })
      expect((output as { cwd: string }).cwd).toBe(process.cwd())
    }
  })

  test("a write tool fails closed when the session's directory cannot be read: no ask, no run", async () => {
    for (const location of [{}, null]) {
      const { tools, asserts, events } = await setUp({ location })
      await expect(
        tools.get(ADD_ID)!.execute({ repo: "octo/hello" }, { sessionID: SESSION_ID, signal }),
      ).rejects.toThrow(/^invalid_argument: The session's directory could not be read.*pass `repo`/)
      expect(asserts).toEqual([])
      expect(events).toEqual([])
    }
  })

  test("a tool failure reaches the harness as an Error reading <code>: <message>", async () => {
    const { tools } = await setUp({ location: { directory: "/work/project" } })
    const failure = await tools
      .get(FAILING_ID)!
      .execute({}, { sessionID: SESSION_ID, signal })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("not_found: No such issue.")
  })

  test("invalid arguments fail with invalid_argument", async () => {
    const { tools } = await setUp({ location: { directory: "/work/project" } })
    await expect(tools.get(READ_ID)!.execute({ count: "x" }, { sessionID: SESSION_ID, signal })).rejects.toThrow(
      /^invalid_argument: Invalid arguments for github_issue_read/,
    )
  })
})

describe("V2 skills", () => {
  async function withSkillsDir(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "github-tools-skills-"))
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("registers the skills of the injected directory", async () => {
    await withSkillsDir(async (dir) => {
      await mkdir(join(dir, "triage"))
      await writeFile(join(dir, "triage", "SKILL.md"), "---\nname: issue-triage\ndescription: Sort issues\n---\nBody\n")
      const fake = fakeContext()
      await createV2Setup([], { skillsDir: dir })(fake.ctx)
      expect(fake.skills).toEqual([
        {
          id: "issue-triage",
          name: "issue-triage",
          description: "Sort issues",
          path: join(dir, "triage", "SKILL.md"),
          content: "Body\n",
        },
      ])
    })
  })

  test("registers no skill when the directory is missing", async () => {
    const fake = fakeContext()
    await createV2Setup([], { skillsDir: join(tmpdir(), "github-tools-no-such-dir") })(fake.ctx)
    expect(fake.skills).toEqual([])
  })
})
