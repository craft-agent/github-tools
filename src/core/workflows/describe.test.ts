import { describe, expect, test } from "bun:test"
import { defaultBranchRule } from "../../testing/develop-fixtures"
import { branchRule, restNotFound } from "../../testing/releases-fixtures"
import { queryOf } from "../../testing/setup-fixtures"
import { LISTING, workflowListRule } from "../../testing/workflow-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { shortSha } from "../refs"
import { DESCRIBE_CASES, MAIN, TAGGED, describeCase, workflowRules, type DescribeCase } from "./describe.fixtures"

/** The methods of a `gh api` call that change something, and the `gh` commands that do. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]
const WRITE_COMMANDS = [
  ["run", "cancel"],
  ["run", "rerun"],
  ["workflow", "run"],
]

const headline = { text: "About to start the workflow {name}", values: { name: "CI" } }

describe("github_workflow_run", () => {
  test("the default branch, with the commit it is at and pinned", async () => {
    expect(await describeCase(DESCRIBE_CASES.runDefaultBranch)).toEqual({
      headline,
      facts: [
        { label: "Ref", value: "main" },
        { label: "Commit", value: shortSha(MAIN) },
      ],
      pins: { head_sha: MAIN },
    })
  })

  test("a tag, found when no branch has the name", async () => {
    expect(await describeCase(DESCRIBE_CASES.runTag)).toEqual({
      headline,
      facts: [
        { label: "Ref", value: "v1.0.0" },
        { label: "Commit", value: shortSha(TAGGED) },
      ],
      pins: { head_sha: TAGGED },
    })
  })

  test("the inputs in the order given, every value as text, and a head_sha that matches", async () => {
    expect(await describeCase(DESCRIBE_CASES.runWithInputs)).toEqual({
      headline,
      facts: [
        { label: "Ref", value: "main" },
        { label: "Commit", value: shortSha(MAIN) },
        { label: "Inputs", value: "env: prod; count: 3; dry: false" },
      ],
      pins: { head_sha: MAIN },
    })
  })

  test("the pin follows the commit the ref is at", async () => {
    const item = DESCRIBE_CASES.runDefaultBranch
    const moved = "5555555555666666666677777777778888888888"
    const rules = workflowRules(branchRule("main", moved))
    const description = await describeCase({ ...item, rules })
    expect(description?.pins).toEqual({ head_sha: moved })
    expect(description?.facts[1]).toEqual({ label: "Commit", value: shortSha(moved) })
  })

  test("a workflow found by its name in any case is called by the name GitHub gives it", async () => {
    const item = DESCRIBE_CASES.runDefaultBranch
    expect((await describeCase({ ...item, args: { workflow: "ci" } }))?.headline).toEqual(headline)
  })

  const run = DESCRIBE_CASES.runDefaultBranch
  test.each([
    ["a head_sha that is not a SHA", { workflow: "ci.yml", head_sha: "abc" }, run.rules],
    ["a head_sha the ref is not at (stale)", { workflow: "ci.yml", head_sha: "5".repeat(40) }, run.rules],
    ["a workflow that does not exist", { workflow: "nope.yml" }, run.rules],
    ["a workflow that is not active", { workflow: "deploy.yml" }, run.rules],
    [
      "a ref that is no branch or tag",
      { workflow: "ci.yml", ref: "nope" },
      workflowRules(restNotFound("branches/nope"), restNotFound("git/ref/tags/nope")),
    ],
    [
      "a repository without a default branch",
      run.args,
      [repositoryRule(), workflowListRule(LISTING), defaultBranchRule(null)],
    ],
    ["a repository the viewer cannot write to", run.args, workflowRules(repositoryRule({ permission: "READ" }))],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...run, args, rules })).toBeUndefined()
  })
})

describe("every description", () => {
  const cases = Object.values<DescribeCase>(DESCRIBE_CASES)

  test.each(cases.map((item) => [item.name, item] as const))("%s: is within the budgets", async (_name, item) => {
    const description = await describeCase(item)
    expect(description).toBeDefined()
    expect(Array.from(description!.headline!.text).length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH)
    expect(description!.facts.length).toBeLessThanOrEqual(MAX_FACTS)
    for (const { label } of description!.facts) expect(Array.from(label).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
  })

  test.each(cases.map((item) => [item.name, item] as const))(
    "%s: is the same when asked twice",
    async (_name, item) => {
      expect(await describeCase(item)).toEqual(await describeCase(item))
    },
  )

  test.each(cases.map((item) => [item.name, item] as const))("%s: only reads", async (_name, item) => {
    let calls: string[][] = []
    await describeCase(item, (seen) => (calls = seen))
    const isWrite = (args: string[]) =>
      queryOf(args).startsWith("mutation") ||
      WRITE_METHODS.some((method) => args.includes(method)) ||
      WRITE_COMMANDS.some(([command, verb]) => args[0] === command && args[1] === verb)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(isWrite)).toEqual([])
  })
})
