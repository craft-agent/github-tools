import { z } from "zod"

/** The shapes the issue tools return an issue in. */

export const issueBriefSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  repo: z.string(),
})

export const subIssueProgressSchema = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  percent: z.number(),
})

export const issueDetailSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  state_reason: z.string().nullable(),
  body: z.string(),
  author: z.string().nullable(),
  assignees: z.array(z.string()),
  labels: z.array(z.string()),
  milestone: z.object({ number: z.number().int(), title: z.string(), due_on: z.string().nullable() }).nullable(),
  kind: z.string().nullable(),
  issue_type: z.string().nullable(),
  parent: issueBriefSchema.nullable(),
  sub_issues: z.array(issueBriefSchema),
  sub_issue_progress: subIssueProgressSchema,
  blocked_by: z.array(issueBriefSchema),
  blocking: z.array(issueBriefSchema),
  dependencies_error: z.string().nullable(),
  linked_branches: z.array(z.string()),
  closing_pull_requests: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      merged: z.boolean(),
    }),
  ),
  projects: z.array(
    z.object({
      item_id: z.string(),
      archived: z.boolean(),
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
    }),
  ),
  comments: z.array(
    z.object({ author: z.string().nullable(), created_at: z.string(), body: z.string(), url: z.string() }),
  ),
  comment_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type IssueBrief = z.output<typeof issueBriefSchema>
export type IssueDetail = z.output<typeof issueDetailSchema>
export type SubIssueProgress = z.output<typeof subIssueProgressSchema>
