import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, githubTargets } from "../core"
import { tempRepo } from "../testing/git-repo"
import { ALL_TOOLS } from "../tools"
import { loadSkills } from "./skills"
import type { V1AskRequest, V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

test("the package ships the github-issues skill", async () => {
  const shipped = await loadSkills(new URL("../../skills/", import.meta.url))
  expect(shipped.map((skill) => skill.id)).toContain("github-issues")
})

test("the package profile reads GITHUB_TOOLS_TOOLSETS and GITHUB_TOOLS_READ_ONLY", async () => {
  const { tool } = await createV1Server(ALL_TOOLS, {
    env: { GITHUB_TOOLS_TOOLSETS: "releases", GITHUB_TOOLS_READ_ONLY: "true" },
  })({}, {})
  expect(Object.keys(tool)).toEqual(
    ALL_TOOLS.filter((spec) => spec.toolset === "releases" && spec.class === "read").map((spec) => spec.id),
  )
})

const fixture = defineTool({
  id: "github_issue_comment",
  title: "Comment",
  description: "A test tool.",
  toolset: "issues",
  class: "add",
  input: z.object({ repo: z.string().optional(), issue: z.string().optional(), branch_repo: z.string().optional() }),
  output: z.object({ own_dir: z.string().optional() }),
  targets: githubTargets({ repo: "repo", issue: "issue", branch_repo: "repo" }),
  execute: async (_args, ctx) => ({ own_dir: ctx.ownDir }),
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

for (const version of ["V1", "V2"] as const) {
  async function asked(
    args: Record<string, unknown>,
    cwd: string,
    ownDir?: string,
    realId?: string,
    env: Record<string, string | undefined> = {},
  ) {
    const requests: V1AskRequest[] = []
    const stop = new Error("stopped at the question")
    const record = async (request: V1AskRequest) => {
      requests.push(request)
      if (realId !== undefined) throw stop
    }
    const specs = realId === undefined ? [fixture] : ALL_TOOLS
    const id = realId ?? fixture.id
    const signal = new AbortController().signal
    let pending: Promise<unknown>
    if (version === "V1") {
      const { tool } = await createV1Server(specs, { env, ownDir })({}, {})
      const context: V1ToolContext = { directory: cwd, worktree: cwd, abort: signal, ask: record }
      pending = tool[id]!.execute(args, context)
    } else {
      const tools = new Map<string, V2Tool>()
      const ctx: V2Context = {
        session: { get: async () => ({ location: { directory: cwd } }) },
        permission: {
          assert: async (request) =>
            record({
              permission: request.action,
              patterns: request.resources,
              always: request.save ?? [],
              metadata: request.metadata ?? {},
            }),
        },
        tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
        skill: { transform: async () => {} },
      }
      await createV2Setup(specs, { env, ownDir })(ctx)
      pending = tools.get(id)!.execute(args, { sessionID: "ses_1", signal })
    }
    if (realId !== undefined) await expect(pending).rejects.toBe(stop)
    else await pending
    return requests[0]!
  }

  describe(`${version} GitHub permissions`, () => {
    test("the package profile reads GITHUB_TOOLS_LANGUAGE", async () => {
      const request = await asked({ repo: "Octo/Hello" }, "/work/project", undefined, undefined, {
        GITHUB_TOOLS_LANGUAGE: "ja",
      })
      expect(request.metadata.message).toContain("対象: octo/hello")
    })

    test("uses the origin, a qualified issue or every repository the call writes to", async () => {
      const repo = tempRepo("git@github.com:Octo/Hello.git")
      cleanups.push(repo.cleanup)
      for (const [args, expected] of [
        [{}, ["octo/hello"]],
        [{ issue: "Other/Repo#4" }, ["other/repo"]],
        [{ issue: "3", branch_repo: "Fork/Hello" }, ["fork/hello", "octo/hello"]],
      ] as const) {
        const request = await asked(args, repo.dir)
        expect(request.patterns).toEqual([...expected])
        expect(request.always).toEqual([...expected])
        for (const target of expected) expect(request.metadata.message).toContain(`Target: ${target}`)
      }
    })

    test("unresolved repositories ask for * without saving it, including beside a known repository", async () => {
      const repo = tempRepo()
      cleanups.push(repo.cleanup)
      for (const args of [{}, { repo: "not a repo" }]) {
        const request = await asked(args, repo.dir)
        expect([request.patterns, request.always]).toEqual([["*"], []])
      }
      const request = await asked({ issue: "a/b#1", branch_repo: "not a repo" }, repo.dir)
      expect([request.patterns, request.always]).toEqual([["a/b", "*"], ["a/b"]])
    })

    test("a bare issue number in the install directory asks for *", async () => {
      const repo = tempRepo("git@github.com:Octo/Self.git")
      cleanups.push(repo.cleanup)
      const request = await asked({ issue: "3" }, repo.dir, repo.dir)
      expect(request.patterns).toEqual(["*"])
    })

    test("the real relate tool asks for each repository, resolving bare numbers against the issue", async () => {
      const request = await asked(
        { issue: "a/x#1", add_blocked_by: ["b/y#2", "3"] },
        "/work/project",
        undefined,
        "github_issue_relate",
      )
      expect(request.permission).toBe("github_issue_relate")
      expect([request.patterns, request.always]).toEqual([
        ["a/x", "b/y"],
        ["a/x", "b/y"],
      ])
    })

    test("the real develop tool asks for the branch repository beside the issue's", async () => {
      const request = await asked(
        { issue: "a/x#1", branch_repo: "c/z" },
        "/work/project",
        undefined,
        "github_issue_develop",
      )
      expect([request.patterns, request.always]).toEqual([
        ["a/x", "c/z"],
        ["a/x", "c/z"],
      ])
    })
  })
}
