import { expect, test } from "bun:test"
import { z } from "zod"
import { PIN_PATTERN, defineTool, githubTargets } from "../core"
import { approvalOf, checkPin } from "./pin"

test("approval resolves a lowercased GitHub repository and its pin rejects a different repository", async () => {
  const spec = defineTool({
    id: "github_issue_comment",
    title: "Comment",
    description: "A test tool.",
    toolset: "issues",
    class: "add",
    input: z.object({ repo: z.string() }),
    output: z.object({}),
    targets: githubTargets({ repo: "repo" }),
    describe: () => ({ facts: [{ label: "Issue", value: "7" }] }),
    execute: async () => ({}),
  })
  const ctx = { cwd: "/work" }
  const approval = await approvalOf(spec, { repo: "Octo/Todo" }, ctx)
  expect(approval.resources).toEqual(["octo/todo"])
  expect(approval.pin).toMatch(PIN_PATTERN)
  await expect(checkPin(spec, { repo: "Octo/Other" }, ctx, approval.pin)).rejects.toMatchObject({ code: "stale" })
})
