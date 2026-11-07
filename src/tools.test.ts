import { describe, expect, test } from "bun:test"
import type { TargetKind } from "./core"
import { ALL_TOOLS } from "./tools"

/** What every tool that writes to one pull request declares; spelled out here so the pin does not follow the constant. */
const PR_TARGETS: Record<string, TargetKind> = { pr: "pull", repo: "repo" }

/**
 * The arguments each write tool declares as naming a repository it writes to.
 * A new write tool, or a new argument that carries a repository, is added here
 * on purpose: an undeclared one would be written to without being asked for.
 */
const EXPECTED_TARGETS: Record<string, Record<string, TargetKind>> = {
  github_label_create: { repo: "repo" },
  github_label_edit: { repo: "repo" },
  github_label_delete: { repo: "repo" },
  github_milestone_create: { repo: "repo" },
  github_milestone_edit: { repo: "repo" },
  github_repo_create: { repo: "repo" },
  github_repo_edit: { repo: "repo" },
  github_repo_visibility: { repo: "repo" },
  github_repo_archive: { repo: "repo" },
  github_repo_unarchive: { repo: "repo" },
  github_ruleset_create: { repo: "repo" },
  github_ruleset_edit: { repo: "repo" },
  github_ruleset_delete: { repo: "repo" },
  github_release_create: { repo: "repo" },
  github_release_edit: { repo: "repo" },
  github_release_delete: { repo: "repo" },
  github_release_publish: { repo: "repo" },
  github_run_rerun: { run: "run", repo: "repo" },
  github_run_cancel: { run: "run", repo: "repo" },
  github_workflow_run: { repo: "repo" },
  github_issue_create: { repo: "repo", parent: "issue", blocked_by: "issues", project: "optional_board" },
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
  github_pr_create: { repo: "repo", project: "optional_board" },
  github_pr_edit: PR_TARGETS,
  github_pr_comment: PR_TARGETS,
  github_pr_ready: PR_TARGETS,
  github_pr_close: PR_TARGETS,
  github_pr_reopen: PR_TARGETS,
  github_pr_review: PR_TARGETS,
  github_pr_merge: PR_TARGETS,
  github_stack_link: { repo: "repo" },
  github_stack_unlink: { pr: "pull", repo: "repo" },
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
  github_issue_create: { issue_fields: "field values of the issue it creates" },
  github_issue_edit: {
    issue_fields: "field values of the issue it edits",
    clear_issue_fields: "field names of the issue it edits",
  },
  github_issue_relate: { remove_parent: "a flag; the parent is read from the issue" },
  github_repo_edit: { has_issues: "a flag that turns the repository's issues on or off" },
  github_project_field_ensure: {
    repo: "where the board lookup starts; nothing is written to it",
    issue_field: "a flag; the column is added to the board, no issue is written",
  },
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
