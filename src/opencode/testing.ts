import { z } from "zod"
import { ToolError, defineTool, type ToolSpec, type Toolset, type WriteClass } from "../core"

/** Fixtures the OpenCode plugin tests share. */

export const toolInput = z.object({
  repo: z.string().describe("The repository, as owner/name.").optional(),
  count: z.number().int().describe("How many.").optional(),
})
export const toolOutput = z.object({
  tool: z.string(),
  cwd: z.string(),
  count: z.number().optional(),
  own_dir: z.string().optional(),
})

/** What a write fixture takes beyond a read one: an issue, and a second repository it may write to. */
const writeInput = toolInput.extend({ issue: z.string().optional(), branch_repo: z.string().optional() })
const WRITE_TARGETS = { issue: "issue", repo: "repo", branch_repo: "repo" } as const

export const READ_ID = "github_issue_read"
export const ADD_ID = "github_issue_comment"
export const LABEL_ID = "github_issue_label"
export const ADMIN_ID = "github_release_publish"
export const FAILING_ID = "github_issue_close"

function fixture(id: string, toolset: Toolset, writeClass: WriteClass, events: string[]): ToolSpec {
  return defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    ...(writeClass === "read" ? {} : { targets: WRITE_TARGETS }),
    input: writeClass === "read" ? toolInput : writeInput,
    output: toolOutput,
    async execute(args, ctx) {
      events.push(`execute:${id}`)
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

/**
 * A read and two add tools of `issues`, an administrative tool of `releases`, and
 * an `issues` tool that fails with `not_found`; `events` logs each execution.
 */
export function fixtureSpecs(events: string[]): ToolSpec[] {
  return [
    fixture(READ_ID, "issues", "read", events),
    fixture(ADD_ID, "issues", "add", events),
    defineTool({
      ...fixture(LABEL_ID, "issues", "add", events),
      describe: (args) => ({
        facts: [{ label: "Repository", value: String(args.repo ?? "here") }],
        text: "Body\u202E",
      }),
    }),
    fixture(ADMIN_ID, "releases", "administrative", events),
    defineTool({
      id: FAILING_ID,
      title: FAILING_ID,
      description: FAILING_ID,
      toolset: "issues",
      class: "overwrite",
      input: toolInput,
      output: toolOutput,
      async execute() {
        throw new ToolError("not_found", "No such issue.")
      },
    }),
  ]
}
