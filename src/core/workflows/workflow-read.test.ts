import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import { failure } from "../../testing/issue-fixtures"
import { CI, DEPLOY, LISTING, workflowListRule as listRule } from "../../testing/workflow-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { workflowRead } from "./workflow-read"

const { use: install, run } = writeHarness(workflowRead)

/** The fake `gh`, whose calls leave out the one-time `--version` check. */
function use(rules: GhRule[]) {
  const installed = install(rules)
  return { calls: () => installed.calls().filter((args) => args[0] !== "--version") }
}

const YAML = "name: CI\non:\n  workflow_dispatch:\n    inputs:\n      env: {}\n"

const detailRule = (workflow: { id: number }): GhRule => ({
  match: `^api repos/octo/hello/actions/workflows/${workflow.id}$`,
  stdout: JSON.stringify({
    ...workflow,
    html_url: `https://github.com/octo/hello/actions/workflows/x${workflow.id}.yml`,
  }),
})
const fileRule = (stdout = YAML): GhRule => ({ match: "contents/", stdout })

describe("list", () => {
  test("lists every workflow, disabled ones included", async () => {
    const installed = use([listRule(LISTING)])
    expect(await run({ method: "list" })).toEqual({ repo: "octo/hello", workflows: LISTING })
    expect(installed.calls()).toEqual([
      ["workflow", "list", "--repo", "octo/hello", "--all", "--limit", "1000", "--json", "id,name,path,state"],
    ])
  })

  test("a missing repository is not_found", async () => {
    use([{ match: "^workflow list", stderr: "HTTP 404: Not Found", code: 1 }])
    const error = await failure(run({ method: "list", repo: "octo/gone" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Repository octo/gone was not found, or the viewer cannot see it.")
  })
})

describe("view", () => {
  test("reads the workflow and its file at the default branch", async () => {
    const installed = use([listRule(LISTING), detailRule(CI), fileRule()])
    expect(await run({ method: "view", workflow: "ci.yml" })).toEqual({
      repo: "octo/hello",
      workflow: { ...CI, url: "https://github.com/octo/hello/actions/workflows/x5.yml" },
      ref: null,
      file: YAML,
      hints: [],
    })
    expect(installed.calls().find((args) => args.includes("-H"))).toEqual([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      "repos/octo/hello/contents/.github/workflows/ci.yml",
    ])
  })

  test("reads the file at a ref, which is URL-encoded", async () => {
    const installed = use([listRule(LISTING), detailRule(CI), fileRule()])
    const result = await run({ method: "view", workflow: "CI", ref: "feat/a b" })
    expect(result.ref).toBe("feat/a b")
    expect(installed.calls().find((args) => args.includes("-H"))![3]).toBe(
      "repos/octo/hello/contents/.github/workflows/ci.yml?ref=feat%2Fa%20b",
    )
  })

  test("a file that is not there is null, with a hint", async () => {
    use([listRule(LISTING), detailRule(CI), { match: "contents/", stderr: "gh: Not Found (HTTP 404)", code: 1 }])
    const result = await run({ method: "view", workflow: "5", ref: "gone" })
    expect(result.file).toBeNull()
    expect(result.hints).toHaveLength(1)
    expect(result.hints![0]).toContain("no workflow file")
  })

  test.each([
    ["5", "id"],
    [".GitHub/workflows/CI.yml", "path"],
    ["CI.YML", "file name"],
    ["deploy", "name"],
  ])("resolves %p by %s", async (wanted) => {
    use([listRule(LISTING), detailRule(CI), detailRule(DEPLOY), fileRule()])
    const result = await run({ method: "view", workflow: wanted })
    expect(result.workflow?.id).toBe(wanted === "deploy" ? 6 : 5)
  })

  test("an id or path wins over a name that looks the same", async () => {
    const odd = { id: 7, name: "5", path: ".github/workflows/odd.yml", state: "active" }
    use([listRule([CI, odd]), detailRule(CI), fileRule()])
    expect((await run({ method: "view", workflow: "5" })).workflow?.id).toBe(5)
  })

  test("an ambiguous name lists the candidates", async () => {
    const other = { id: 8, name: "CI", path: ".github/workflows/ci2.yml", state: "active" }
    use([listRule([CI, other])])
    const error = await failure(run({ method: "view", workflow: "ci" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      '"ci" matches several workflows of octo/hello: CI (.github/workflows/ci.yml, id 5); CI (.github/workflows/ci2.yml, id 8). Give the id or the path.',
    )
  })

  test("a missing workflow lists up to ten of them", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: i + 10,
      name: `W${i}`,
      path: `.github/workflows/w${i}.yml`,
      state: "active",
    }))
    use([listRule(many)])
    const error = await failure(run({ method: "view", workflow: "nope" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain('No workflow "nope" in octo/hello. Its workflows: W0 (.github/workflows/w0.yml);')
    expect(error.message).toContain("W9 (.github/workflows/w9.yml), and 2 more.")
    expect(error.message).not.toContain("W10")
  })

  test.each([undefined, "", "  "])("missing workflow %p", async (workflow) => {
    const error = await failure(run({ method: "view", workflow }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("needs `workflow`")
  })
})

test.each([
  [{ method: "list", workflow: "ci" }, "workflow", "view", "list"],
  [{ method: "list", ref: "main" }, "ref", "view", "list"],
])("refuses an argument of another method: %j", async (args, name, owner, method) => {
  const error = await failure(run(args))
  expect(error.message).toBe(`"${name}" is an argument of method "${owner}", not "${method}"; leave it out.`)
})
