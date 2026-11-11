import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { linkedBoardsRule, octoBoardRules, rawBoard } from "../../testing/project-fixtures"
import { mutationRule, mutationsSent, queryOf } from "../../testing/setup-fixtures"
import { repositoryRule, sent } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { targetKinds } from "../github/targets"
import { projectLink, projectUnlink } from "./link"

const SUMMARY = { number: 3, title: "Roadmap", url: "https://github.com/orgs/octo/projects/3", owner: "octo" }
const BOARD = { project: "octo/3" }

const LINKED = [rawBoard(3)]
const LINK = mutationRule("linkProjectV2ToRepository", { linkProjectV2ToRepository: { repository: { id: "R_1" } } })
const UNLINK = mutationRule("unlinkProjectV2FromRepository", {
  unlinkProjectV2FromRepository: { repository: { id: "R_1" } },
})

describe("github_project_link", () => {
  const { use, run } = writeHarness(projectLink)

  test("links the board to the working tree's repository", async () => {
    const installed = use([...octoBoardRules(3), repositoryRule(), linkedBoardsRule("octo", "hello", []), LINK])
    expect(await run(BOARD)).toEqual({ project: SUMMARY, repo: "octo/hello", changed: true })
    const [call, ...others] = mutationsSent(installed)
    expect(others).toEqual([])
    expect(queryOf(call!)).toContain("linkProjectV2ToRepository(input:{projectId:$project,repositoryId:$repo})")
    expect(call).toEqual(expect.arrayContaining(["project=PVT_3", "repo=R_1"]))
  })

  test("a board that is already linked is left as it is", async () => {
    const installed = use([...octoBoardRules(3), repositoryRule(), linkedBoardsRule("octo", "hello", LINKED), LINK])
    expect((await run(BOARD)).changed).toBe(false)
    expect(mutationsSent(installed)).toEqual([])
  })

  test("a repo argument names the repository, which is also where the lookup starts", async () => {
    const installed = use([
      repositoryRule({ repo: "acme/widgets" }),
      linkedBoardsRule("acme", "widgets", [
        rawBoard(4, { title: "Plan", owner: { __typename: "Organization", login: "acme" } }),
      ]),
      LINK,
    ])
    const result = await run({ project: "plan", repo: "acme/widgets" })
    expect(result).toMatchObject({ repo: "acme/widgets", changed: false })
    expect(mutationsSent(installed)).toEqual([])
  })

  test("the viewer must be able to update the board and write to the repository, before anything is written", async () => {
    const readOnly = use([
      ...octoBoardRules(3, { viewerCanUpdate: false }),
      repositoryRule(),
      linkedBoardsRule("octo", "hello", []),
      LINK,
    ])
    expect((await failure(run(BOARD))).code).toBe("forbidden")
    expect(mutationsSent(readOnly)).toEqual([])

    const noWrite = use([
      ...octoBoardRules(3),
      repositoryRule({ permission: "READ" }),
      linkedBoardsRule("octo", "hello", []),
      LINK,
    ])
    expect((await failure(run(BOARD))).code).toBe("forbidden")
    expect(mutationsSent(noWrite)).toEqual([])
    expect(sent(noWrite).some((args) => args.join(" ").includes("projectsV2(first"))).toBe(false)
  })

  test("a board of another owner than the repository's is invalid_argument, before anything is read or written", async () => {
    const installed = use([...octoBoardRules(3), repositoryRule({ repo: "acme/widgets" }), LINK])
    const error = await failure(run({ ...BOARD, repo: "acme/widgets" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "A board can only be linked to a repository of its own owner: octo/projects/3 belongs to octo, acme/widgets to acme.",
    )
    expect(mutationsSent(installed)).toEqual([])
    expect(sent(installed).some((args) => args.join(" ").includes("viewerPermission"))).toBe(false)
  })

  test("owners are compared without regard to case", async () => {
    const installed = use([
      ...octoBoardRules(3),
      repositoryRule({ repo: "OCTO/hello" }),
      linkedBoardsRule("OCTO", "hello", []),
      LINK,
    ])
    expect((await run({ ...BOARD, repo: "OCTO/hello" })).changed).toBe(true)
    expect(mutationsSent(installed)).toHaveLength(1)
  })

  test("declares its board and repository as what it writes to", () => {
    expect(projectLink).toMatchObject({ class: "idempotent", toolset: "projects" })
    expect(targetKinds(projectLink.targets)).toEqual({ project: "board", repo: "repo" })
    expect(projectLink.description).toContain("gh auth refresh -s project")
  })
})

describe("github_project_unlink", () => {
  const { use, run } = writeHarness(projectUnlink)

  test("unlinks a board that is linked", async () => {
    const installed = use([...octoBoardRules(3), repositoryRule(), linkedBoardsRule("octo", "hello", LINKED), UNLINK])
    expect(await run(BOARD)).toEqual({ project: SUMMARY, repo: "octo/hello", changed: true })
    expect(queryOf(mutationsSent(installed)[0]!)).toContain("unlinkProjectV2FromRepository(input")
  })

  test("a board that is not linked is left as it is", async () => {
    const installed = use([...octoBoardRules(3), repositoryRule(), linkedBoardsRule("octo", "hello", []), UNLINK])
    expect((await run(BOARD)).changed).toBe(false)
    expect(mutationsSent(installed)).toEqual([])
  })

  test("needs no same-owner check: a board of another owner is simply not linked", async () => {
    const installed = use([
      ...octoBoardRules(3),
      repositoryRule({ repo: "acme/widgets" }),
      linkedBoardsRule("acme", "widgets", []),
      UNLINK,
    ])
    expect(await run({ ...BOARD, repo: "acme/widgets" })).toMatchObject({ repo: "acme/widgets", changed: false })
    expect(mutationsSent(installed)).toEqual([])
  })

  test("declares its board and repository as what it writes to", () => {
    expect(projectUnlink).toMatchObject({ class: "idempotent" })
    expect(targetKinds(projectUnlink.targets)).toEqual({ project: "board", repo: "repo" })
  })
})
