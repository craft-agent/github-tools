import { describe, expect, test } from "bun:test"
import type { GhRule } from "../../testing/fake-gh"
import {
  commands,
  editedRule,
  issueFieldsRule,
  milestonesRule,
  repositoryRule,
  sent,
  writeRules,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueEdit } from "./edit"

const { use, run } = writeHarness(issueEdit)

const EDIT = ["issue", "edit", "12", "--repo", "octo/hello"]

/** The rules every call needs, after the ones a test adds, with an edit that prints issue 12's URL. */
const base = (...rules: GhRule[]): GhRule[] => writeRules(...rules, editedRule(12))

describe("one gh issue edit", () => {
  test("a title alone: no body is read or sent, and the result says what changed", async () => {
    const installed = use(base())
    expect(await run({ issue: "12", title: "  New title " })).toEqual({
      repo: "octo/hello",
      issue: 12,
      url: "https://github.com/octo/hello/issues/12",
      changed: ["title"],
      kind: null,
      milestone: null,
      foreign: false,
    })
    expect(commands(installed)).toEqual([{ args: [...EDIT, "--title", "New title"], stdin: "" }])
    expect(installed.calls().filter((args) => args.join(" ").includes("labels(first"))).toEqual([])
  })

  test("a body replaces the old one and goes on stdin, also an empty one", async () => {
    const installed = use(base())
    await run({ issue: "12", body: "New\n\nbody" })
    expect((await run({ issue: "12", body: "" })).changed).toEqual(["body"])
    expect(commands(installed)).toEqual([
      { args: [...EDIT, "--body-file", "-"], stdin: "New\n\nbody" },
      { args: [...EDIT, "--body-file", "-"], stdin: "" },
    ])
  })

  test("every list and the milestone become flags, in a fixed order", async () => {
    const installed = use(base(milestonesRule("v1")))
    const result = await run({
      issue: "#12",
      title: "T",
      body: "B",
      add_labels: ["a", "b"],
      remove_labels: ["c"],
      add_assignees: ["@me"],
      remove_assignees: ["bob", "carol"],
      milestone: "V1",
    })
    expect(commands(installed)).toEqual([
      {
        args: [
          ...EDIT,
          "--title",
          "T",
          "--body-file",
          "-",
          "--add-label",
          "a",
          "--add-label",
          "b",
          "--remove-label",
          "c",
          "--add-assignee",
          "@me",
          "--remove-assignee",
          "bob",
          "--remove-assignee",
          "carol",
          "--milestone",
          "v1",
        ],
        stdin: "B",
      },
    ])
    expect(result.changed).toEqual([
      "title",
      "body",
      "add_labels",
      "remove_labels",
      "add_assignees",
      "remove_assignees",
      "milestone",
    ])
    expect(result.milestone).toEqual({ number: 1, title: "v1", created: false })
  })

  test("an issue URL names its own repository", async () => {
    const installed = use([repositoryRule({ repo: "other/thing" }), editedRule(3)])
    const result = await run({ issue: "https://github.com/other/thing/issues/3", title: "T" })
    expect(result.repo).toBe("other/thing")
    expect(commands(installed)[0]!.args.slice(0, 5)).toEqual(["issue", "edit", "3", "--repo", "other/thing"])
  })
})

describe("append_body", () => {
  test("reads the body, then writes once: the old text, a blank line, the new text", async () => {
    const installed = use(base(issueFieldsRule({ body: "It crashes.\n\n" })))
    const result = await run({ issue: "12", append_body: "## Update\nFixed in main." })
    expect(commands(installed)).toEqual([
      { args: [...EDIT, "--body-file", "-"], stdin: "It crashes.\n\n## Update\nFixed in main." },
    ])
    expect(result.changed).toEqual(["append_body"])
    const calls = sent(installed).map((args) => args.join(" "))
    expect(calls.findIndex((call) => call.includes("stateReason body labels"))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("issue edit")),
    )
    expect(calls.filter((call) => call.includes("stateReason body labels"))).toHaveLength(1)
  })

  test("an empty body takes the text alone", async () => {
    const installed = use(base(issueFieldsRule({ body: " \n" })))
    await run({ issue: "12", append_body: "First words." })
    expect(commands(installed)[0]!.stdin).toBe("First words.")
  })
})
