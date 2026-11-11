import { afterEach, describe, expect, test } from "bun:test"
import {
  BOARD_FIELD_NODES,
  BOARD_SUMMARY,
  addItemRule,
  blockersRule,
  boardWithFields,
  mutationNames,
  mutationsOf,
  setValueRule,
} from "../../testing/board-write-fixtures"
import type { GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { failure } from "../../testing/issue-fixtures"
import { fieldsRule, linkedBoardsRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { createdRule, issueFieldsRule, writeRules, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { writeTargets } from "../targets"
import { issueCreate } from "./create"

const { use, run } = writeHarness(issueCreate)

const BOARD = { project: "octo/3" }

const base = (...rules: GhRule[]): GhRule[] => writeRules(createdRule(7), issueFieldsRule(), ...rules)

const repos: TempRepo[] = []
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

function tree(origin?: string): string {
  const repo = tempRepo(origin)
  repos.push(repo)
  return repo.dir
}

describe("a board", () => {
  test("the issue is put on it by its number and starts as Todo", async () => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const result = await run({ title: "T", ...BOARD })
    expect(result.project).toEqual({ ...BOARD_SUMMARY, item_id: "PVTI_new", fields: { Status: "Todo" } })
    expect(result.errors).toEqual({})
    const [add, status, ...others] = mutationsOf(installed)
    expect(others).toEqual([])
    expect(add).toMatchObject({ name: "addProjectV2ItemById", vars: { project: "PVT_3", content: "I_12" } })
    expect(status).toMatchObject({
      name: "updateProjectV2ItemFieldValue",
      vars: { project: "PVT_3", item: "PVTI_new", field: "F_status", value: "O_todo" },
    })
  })

  test("a board by title looks up linked boards on the repository", async () => {
    use(
      base(
        linkedBoardsRule("octo", "hello", [rawBoard(4, { title: "Roadmap" })]),
        fieldsRule(BOARD_FIELD_NODES),
        addItemRule("PVTI_new"),
        setValueRule(),
      ),
    )
    const result = await run({ title: "T", project: "Roadmap" })
    expect(result.project).toEqual({
      number: 4,
      title: "Roadmap",
      url: "https://github.com/orgs/octo/projects/4",
      owner: "octo",
      item_id: "PVTI_new",
      fields: { Status: "Todo" },
    })
    expect(result.errors).toEqual({})
  })

  test("starts as Waiting when blocked_by has an open blocker and the board has Waiting", async () => {
    const installed = use(base(...boardWithFields(), blockersRule("OPEN"), addItemRule("PVTI_new"), setValueRule()))
    const result = await run({ title: "T", ...BOARD, blocked_by: ["2"] })
    expect(result.relations.blocked_by).toEqual(["octo/hello#2"])
    expect(result.project?.fields).toEqual({ Status: "Waiting" })
    expect(result.errors).toEqual({})
    const [, status] = mutationsOf(installed)
    expect(status).toMatchObject({
      name: "updateProjectV2ItemFieldValue",
      vars: { project: "PVT_3", item: "PVTI_new", field: "F_status", value: "O_wait" },
    })
  })

  test("starts as Todo when all blockers are closed", async () => {
    const installed = use(base(...boardWithFields(), blockersRule("CLOSED"), addItemRule("PVTI_new"), setValueRule()))
    const result = await run({ title: "T", ...BOARD, blocked_by: ["2"] })
    expect(result.relations.blocked_by).toEqual(["octo/hello#2"])
    expect(result.project?.fields).toEqual({ Status: "Todo" })
    expect(result.errors).toEqual({})
    const [, status] = mutationsOf(installed)
    expect(status).toMatchObject({
      name: "updateProjectV2ItemFieldValue",
      vars: { project: "PVT_3", item: "PVTI_new", field: "F_status", value: "O_todo" },
    })
  })

  test("starts as Todo when reading blockers fails, and records in errors.blocked_by", async () => {
    const installed = use(
      base(
        ...boardWithFields(),
        { match: "blockedBy\\(first", stderr: "cannot read blockers", code: 1 },
        addItemRule("PVTI_new"),
        setValueRule(),
      ),
    )
    const result = await run({ title: "T", ...BOARD, blocked_by: ["2"] })
    expect(result.relations.blocked_by).toEqual(["octo/hello#2"])
    expect(result.project?.fields).toEqual({ Status: "Todo" })
    expect(result.errors).toEqual({ blocked_by: "upstream_error: gh failed (exit 1): cannot read blockers" })
    const [, status] = mutationsOf(installed)
    expect(status).toMatchObject({
      name: "updateProjectV2ItemFieldValue",
      vars: { project: "PVT_3", item: "PVTI_new", field: "F_status", value: "O_todo" },
    })
  })

  test("field values are set beside the Todo default, and a Status given replaces it", async () => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const result = await run({ title: "T", ...BOARD, fields: { Estimate: 3 } })
    expect(result.project?.fields).toEqual({ Estimate: 3, Status: "Todo" })
    expect(mutationsOf(installed).map(({ vars }) => vars.field)).toEqual([undefined, "F_estimate", "F_status"])

    const done = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const withStatus = await run({ title: "T", ...BOARD, fields: { status: "done" } })
    expect(withStatus.project?.fields).toEqual({ Status: "Done" })
    expect(mutationsOf(done).map(({ vars }) => vars.value)).toEqual([undefined, "O_done"])
  })

  test("a failing addContentToBoard gives errors.project with project null and the issue returned", async () => {
    const installed = use(
      base({ match: "addProjectV2ItemById", stderr: "boom", code: 1 }, ...boardWithFields(), setValueRule()),
    )
    const result = await run({ title: "T", ...BOARD })
    expect(result.issue).toEqual({ number: 7, url: "https://github.com/octo/hello/issues/7", title: "T" })
    expect(result.project).toBeNull()
    expect(result.errors).toEqual({ project: "upstream_error: gh failed (exit 1): boom" })
    expect(mutationNames(installed)).toEqual(["addProjectV2ItemById"])
  })

  test("a failing field write gives errors.fields.<Name>", async () => {
    use(
      base(
        { match: "updateProjectV2ItemFieldValue[\\s\\S]*field=F_estimate", stderr: "boom", code: 1 },
        ...boardWithFields(),
        addItemRule("PVTI_new"),
        setValueRule(),
      ),
    )
    const result = await run({ title: "T", ...BOARD, fields: { Estimate: 1, Notes: "kept" } })
    expect(result.project).toEqual({ ...BOARD_SUMMARY, item_id: "PVTI_new", fields: { Notes: "kept", Status: "Todo" } })
    expect(result.errors).toEqual({ "fields.Estimate": "upstream_error: gh failed (exit 1): boom" })
  })

  test.each([
    ["an unknown field", { Nope: "x" }, 'no field "Nope"'],
    ["an unknown option", { Status: "Blocked" }, 'no option "Blocked"'],
    ["a bad date", { Target: "tomorrow" }, "YYYY-MM-DD"],
  ])("%s fails before the issue is made", async (_name, fields, expected) => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const error = await failure(run({ title: "T", ...BOARD, fields }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(expected)
    expect(writes(installed)).toEqual([])
    expect(mutationNames(installed)).toEqual([])
  })

  test("fields without project is refused before the issue is made", async () => {
    const installed = use(base(...boardWithFields(), addItemRule("PVTI_new"), setValueRule()))
    const error = await failure(run({ title: "T", fields: { Estimate: 1 } }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("need project")
    expect(writes(installed)).toEqual([])
  })

  test("a board the viewer cannot update is forbidden, before the issue is made", async () => {
    const installed = use(base(...octoBoardRules(3, { viewerCanUpdate: false }), addItemRule("PVTI_new")))
    const error = await failure(run({ title: "T", ...BOARD }))
    expect(error.code).toBe("forbidden")
    expect(writes(installed)).toEqual([])
  })

  describe("permission targets", () => {
    test("names the board beside the repository", async () => {
      const dir = tree("https://github.com/octo/hello.git")
      const targets = await writeTargets(issueCreate, { title: "T", project: "craftsamo/1", repo: "a/b" }, { cwd: dir })
      expect(targets).toEqual(["a/b", "craftsamo/projects/1"])
    })

    test("a bare board number takes the owner of the repository", async () => {
      const dir = tree("https://github.com/octo/hello.git")
      const targets = await writeTargets(issueCreate, { title: "T", project: "5", repo: "a/b" }, { cwd: dir })
      expect(targets).toEqual(["a/b", "a/projects/5"])
    })

    test("without project names only the repository", async () => {
      const dir = tree("https://github.com/octo/hello.git")
      const targets = await writeTargets(issueCreate, { title: "T", repo: "a/b" }, { cwd: dir })
      expect(targets).toEqual(["a/b"])
    })
  })
})
