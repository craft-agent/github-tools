import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, githubTargets } from "../core"
import { tempRepo } from "../testing/git-repo"
import { EXIT_OK } from "./cli"
import { cli, json } from "./testing"

const spec = defineTool({
  id: "github_issue_comment",
  title: "Comment",
  description: "A test tool.",
  toolset: "issues",
  class: "add",
  input: z.object({ repo: z.string().optional(), issue: z.string().optional(), parent: z.string().optional() }),
  output: z.object({}),
  targets: githubTargets({ issue: "issue", repo: "repo", parent: "issue" }),
  execute: async () => ({}),
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function target(cwd: string, args = {}, ownDir?: string) {
  const run = await cli(["target", spec.id, "--cwd", cwd], JSON.stringify(args), {
    specs: [spec],
    profile: undefined,
    ownDir,
  })
  expect(run.code).toBe(EXIT_OK)
  return json(run).resources
}

describe("GitHub targets", () => {
  test("list reads GITHUB_TOOLS_TOOLSETS and ignores GITHUB_TOOLS_CONFIRM", async () => {
    const release = defineTool({ ...spec, id: "github_release_publish", toolset: "releases" })
    const run = await cli(["list"], "", {
      specs: [spec, release],
      profile: undefined,
      env: { GITHUB_TOOLS_TOOLSETS: "releases", GITHUB_TOOLS_CONFIRM: "ask" },
    })
    expect(run.code).toBe(EXIT_OK)
    expect(json(run).map((entry: { id: string }) => entry.id)).toEqual([release.id])
  })

  test("reads GITHUB_TOOLS_LANGUAGE with the package profile", async () => {
    const run = await cli(["target", spec.id, "--cwd", "/x"], '{"repo":"Octo/Hello"}', {
      specs: [spec],
      profile: undefined,
      env: { GITHUB_TOOLS_LANGUAGE: "ja" },
    })
    expect(run.code).toBe(EXIT_OK)
    expect(json(run).words.details).toBe("詳細")
  })

  test("is the lowercased repo argument", async () => {
    expect(await target("/x", { repo: "Octo/Hello" })).toEqual(["octo/hello"])
  })

  test("is the working tree's origin without a repo argument", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    expect(await target(repo.dir)).toEqual(["octo/hello"])
  })

  test("is the repository a qualified issue names, not the working tree's", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    expect(await target(repo.dir, { issue: "Other/Repo#4" })).toEqual(["other/repo"])
  })

  test("lists every repository the call writes to", async () => {
    const repo = tempRepo("git@github.com:Octo/Hello.git")
    cleanups.push(repo.cleanup)
    expect(await target(repo.dir, { issue: "4", parent: "Other/Repo#2" })).toEqual(["octo/hello", "other/repo"])
  })

  test("is * when the repository cannot be resolved", async () => {
    const repo = tempRepo()
    cleanups.push(repo.cleanup)
    expect(await target(repo.dir)).toEqual(["*"])
    expect(await target(repo.dir, { repo: "not a repo" })).toEqual(["*"])
  })

  test("is * for a bare number in the install directory, and still names a qualified issue there", async () => {
    const repo = tempRepo("git@github.com:Octo/Self.git")
    cleanups.push(repo.cleanup)
    expect(await target(repo.dir, { issue: "3" }, repo.dir)).toEqual(["*"])
    expect(await target(repo.dir, { issue: "o/r#3" }, repo.dir)).toEqual(["o/r"])
    expect(await target(repo.dir, { issue: "3" })).toEqual(["octo/self"])
  })
})
