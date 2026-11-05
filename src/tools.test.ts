import { describe, expect, test } from "bun:test"
import type { TargetKind } from "./core"
import { ALL_TOOLS } from "./tools"

/**
 * The arguments each write tool declares as naming a repository it writes to.
 * A new write tool, or a new argument that carries a repository, is added here
 * on purpose: an undeclared one would be written to without being asked for.
 */
const EXPECTED_TARGETS: Record<string, Record<string, TargetKind>> = {
  github_issue_create: { repo: "repo", parent: "issue", blocked_by: "issues" },
  github_issue_edit: { issue: "issue", repo: "repo" },
  github_issue_comment: { issue: "issue", repo: "repo" },
  github_issue_close: { issue: "issue", repo: "repo" },
  github_issue_reopen: { issue: "issue", repo: "repo" },
  github_issue_relate: {
    issue: "issue",
    repo: "repo",
    parent: "issue",
    add_sub_issues: "issues",
    remove_sub_issues: "issues",
    add_blocked_by: "issues",
    remove_blocked_by: "issues",
    add_blocking: "issues",
    remove_blocking: "issues",
  },
  github_issue_develop: { issue: "issue", repo: "repo", branch_repo: "repo" },
  github_project_create: { owner: "owner", link_repo: "repo" },
  github_project_link: { project: "board", repo: "repo" },
  github_project_unlink: { project: "board", repo: "repo" },
  github_project_field_ensure: { project: "board" },
  github_project_view_ensure: { project: "board" },
  github_project_item_add: { project: "board" },
  github_project_item_create: { project: "board" },
  github_project_item_edit: { item: "item" },
  github_project_item_archive: { item: "item" },
  github_project_item_unarchive: { item: "item" },
  github_project_item_convert: { item: "item", repo: "repo" },
}

/** Arguments that look like they name a repository but do not make the call write to one, and why. */
const NOT_TARGETS: Record<string, Record<string, string>> = {
  github_issue_close: { duplicate_of: "closing as a duplicate writes nothing to the original's repository" },
  github_issue_relate: { remove_parent: "a flag; the parent is read from the issue" },
  github_project_field_ensure: { repo: "where the board lookup starts; nothing is written to it" },
  github_project_view_ensure: { repo: "where the board lookup starts; nothing is written to it" },
  github_project_item_add: { repo: "where the board lookup starts; the issue is only put on the board" },
  github_project_item_create: { repo: "where the board lookup starts; nothing is written to it" },
  github_project_item_edit: { repo: "where the board lookup starts; nothing is written to it" },
  github_project_item_archive: { repo: "where the board lookup starts; nothing is written to it" },
  github_project_item_unarchive: { repo: "where the board lookup starts; nothing is written to it" },
}

/** What makes an argument look like it names a repository or an issue. */
const REPOSITORY_LIKE = /repo|issue|parent|blocked|blocking|duplicate/

const writeTools = ALL_TOOLS.filter((spec) => spec.class !== "read")

describe("the registry's write tools", () => {
  test("every one declares its targets", () => {
    const undeclared = writeTools.filter((spec) => spec.targets === undefined).map((spec) => spec.id)
    expect(undeclared).toEqual([])
  })

  test("the pinned list names exactly the write tools", () => {
    expect(writeTools.map((spec) => spec.id).sort()).toEqual(Object.keys(EXPECTED_TARGETS).sort())
  })

  test("no argument that looks like it names a repository is left undeclared", () => {
    const undeclared = writeTools.flatMap((spec) =>
      Object.keys(spec.input.shape)
        .filter((name) => REPOSITORY_LIKE.test(name))
        .filter((name) => !(name in (spec.targets ?? {})) && !(name in (NOT_TARGETS[spec.id] ?? {})))
        .map((name) => `${spec.id}.${name}`),
    )
    expect(undeclared).toEqual([])
  })

  test.each(Object.entries(EXPECTED_TARGETS))("%s declares exactly its pinned targets", (id, expected) => {
    expect(ALL_TOOLS.find((spec) => spec.id === id)?.targets).toEqual(expected)
  })
})
