import { describe, expect, test } from "bun:test"
import { rawDraftContent, rawIssueContent, rawItem } from "../../testing/board-item-fixtures"
import { BOARD_SUMMARY, itemReadRule, mutationNames, mutationsOf } from "../../testing/board-write-fixtures"
import { failure } from "../../testing/issue-fixtures"
import { itemBoardRule, rawBoard } from "../../testing/project-fixtures"
import { mutationRule } from "../../testing/setup-fixtures"
import {
  commands,
  labelRule,
  milestoneCreatedRule,
  milestonesRule,
  repositoryRule,
  sent,
  writeRules,
} from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { targetKinds } from "../github/targets"
import { projectItemConvert } from "./item-convert"

const { use, run } = writeHarness(projectItemConvert)

const ON_BOARD = itemBoardRule("PVTI_1", rawBoard(3))
const DRAFT = itemReadRule("PVTI_1", rawItem("PVTI_1", { ...rawDraftContent("Plan", "Body"), id: "DI_1" }))
const CONVERT = mutationRule("convertProjectV2DraftIssueItemToIssue", {
  convertProjectV2DraftIssueItemToIssue: {
    item: { id: "PVTI_1", content: { number: 31, url: "https://github.com/octo/hello/issues/31" } },
  },
})
const ISSUE = { number: 31, url: "https://github.com/octo/hello/issues/31" }
const ID = { item: "PVTI_1" }
const edits = (installed: Parameters<typeof commands>[0]) => commands(installed).map(({ args }) => args.slice(5))

describe("a draft", () => {
  test("becomes an issue of the working tree's repository, and nothing else is written", async () => {
    const installed = use(writeRules(ON_BOARD, DRAFT, CONVERT))
    expect(await run(ID)).toEqual({
      project: BOARD_SUMMARY,
      item_id: "PVTI_1",
      issue: ISSUE,
      repo: "octo/hello",
      kind: null,
      milestone: null,
      foreign: false,
      errors: {},
    })
    expect(mutationsOf(installed)).toEqual([
      expect.objectContaining({
        name: "convertProjectV2DraftIssueItemToIssue",
        vars: { item: "PVTI_1", repo: "R_1" },
      }),
    ])
    expect(commands(installed)).toEqual([])
  })

  test("takes its kind, labels and milestone as github_issue_create sets them", async () => {
    const installed = use(writeRules(ON_BOARD, DRAFT, CONVERT, labelRule(true), milestonesRule("v0", "V1")))
    const result = await run({ ...ID, kind: "bug", labels: ["ui", " ui ", "api"], milestone: "v1" })
    expect(result).toMatchObject({
      kind: { name: "type:bug", via: "label" },
      milestone: { number: 2, title: "V1", created: false },
      errors: {},
    })
    expect(edits(installed)).toEqual([
      ["--add-label", "type:bug"],
      ["--add-label", "ui", "--add-label", "api"],
      ["--milestone", "V1"],
    ])
  })

  test("creates a milestone that is missing when create_milestone says so", async () => {
    const installed = use(writeRules(ON_BOARD, DRAFT, CONVERT, milestonesRule("v0"), milestoneCreatedRule(7, "v9")))
    const result = await run({ ...ID, milestone: "v9", create_milestone: true })
    expect(result.milestone).toEqual({ number: 7, title: "v9", created: true })
    expect(edits(installed)).toEqual([["--milestone", "v9"]])
  })

  test("a milestone that is missing fails before the draft is converted", async () => {
    const installed = use(writeRules(ON_BOARD, DRAFT, CONVERT, milestonesRule("v0")))
    const error = await failure(run({ ...ID, milestone: "v9" }))
    expect(error.code).toBe("invalid_argument")
    expect(mutationNames(installed)).toEqual([])
  })

  test("a step that fails once the issue exists is listed under errors, and the others still run", async () => {
    const installed = use(
      writeRules(
        ON_BOARD,
        DRAFT,
        CONVERT,
        labelRule(true),
        milestonesRule("v1"),
        { match: "^issue edit 31 .*type:bug", stderr: "no type", code: 1 },
        { match: "^issue edit 31 .*--add-label ui", stderr: "no such label", code: 1 },
      ),
    )
    const result = await run({ ...ID, kind: "bug", labels: ["ui"], milestone: "v1" })
    expect(result.issue).toEqual(ISSUE)
    expect(result.kind).toBeNull()
    expect(result.milestone).toMatchObject({ title: "v1" })
    expect(result.errors).toEqual({
      kind: "upstream_error: gh failed (exit 1): no type",
      labels: "upstream_error: gh failed (exit 1): no such label",
    })
    expect(edits(installed).at(-1)).toEqual(["--milestone", "v1"])
  })

  test("a milestone that cannot be set is listed under errors and still reported", async () => {
    use(
      writeRules(ON_BOARD, DRAFT, CONVERT, milestonesRule("v1"), {
        match: "^issue edit 31 .*--milestone",
        stderr: "boom",
        code: 1,
      }),
    )
    const result = await run({ ...ID, milestone: "v1" })
    expect(result.milestone).toEqual({ number: 1, title: "v1", created: false })
    expect(result.errors).toEqual({ milestone: "upstream_error: gh failed (exit 1): boom" })
  })

  test("goes to the repo given, and says when that is someone else's tracker", async () => {
    const installed = use([
      repositoryRule({ repo: "acme/widgets", viewer: "alice" }),
      ...writeRules(ON_BOARD, DRAFT, CONVERT),
    ])
    const result = await run({ ...ID, repo: "acme/widgets" })
    expect(result).toMatchObject({ repo: "acme/widgets", foreign: true })
    expect(mutationsOf(installed)[0]!.vars.repo).toBe("R_1")
  })
})

describe("before anything is written", () => {
  test("an item that is not a draft is invalid_argument", async () => {
    const installed = use(writeRules(ON_BOARD, itemReadRule("PVTI_1", rawItem("PVTI_1", rawIssueContent(12))), CONVERT))
    const error = await failure(run(ID))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("is an issue")
    expect(mutationNames(installed)).toEqual([])
  })

  test("a repository the viewer cannot write to is forbidden", async () => {
    const installed = use([repositoryRule({ permission: "READ" }), ON_BOARD, DRAFT, CONVERT])
    expect((await failure(run({ ...ID, kind: "bug" }))).code).toBe("forbidden")
    expect(mutationNames(installed)).toEqual([])
  })

  test("a board the viewer cannot update is forbidden, and the repository is not even asked", async () => {
    const installed = use(writeRules(itemBoardRule("PVTI_1", rawBoard(3, { viewerCanUpdate: false })), DRAFT, CONVERT))
    expect((await failure(run(ID))).code).toBe("forbidden")
    expect(mutationNames(installed)).toEqual([])
    expect(sent(installed).some((args) => args.join(" ").includes("viewerPermission"))).toBe(false)
  })

  test("a kind with a comma, and create_milestone without milestone, are invalid_argument before GitHub is asked", async () => {
    const installed = use(writeRules(ON_BOARD, DRAFT, CONVERT))
    expect((await failure(run({ ...ID, kind: "a,b" }))).code).toBe("invalid_argument")
    expect((await failure(run({ ...ID, create_milestone: true }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })

  test("a draft that does not exist is not_found", async () => {
    use(writeRules(itemBoardRule("PVTI_1", null), CONVERT))
    expect((await failure(run(ID))).code).toBe("not_found")
  })
})

test("declares its item and repository as what it writes to", () => {
  expect(projectItemConvert).toMatchObject({ class: "add", toolset: "projects" })
  expect(targetKinds(projectItemConvert.targets)).toEqual({ item: "item", repo: "repo" })
  expect(projectItemConvert.description).toContain("gh auth refresh -s project")
})
