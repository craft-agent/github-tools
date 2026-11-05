import { z } from "zod"

export type CheckNode = {
  __typename: string
  status?: string | null
  conclusion?: string | null
  state?: string | null
  isRequired?: boolean
}

export type CheckContexts = {
  totalCount?: number
  pageInfo?: { hasNextPage?: boolean }
  nodes?: (CheckNode | null)[] | null
}

export const checksSummarySchema = z.object({
  overall: z.enum(["none", "fail", "pending", "pass"]),
  pass: z.number().int(),
  fail: z.number().int(),
  pending: z.number().int(),
  skipping: z.number().int(),
  required_fail: z.number().int(),
  required_pending: z.number().int(),
  truncated: z.boolean(),
})

export type ChecksSummary = z.output<typeof checksSummarySchema>

/** A cancelled check counts as a failure on purpose, not as a skipped check. */
export function checkBucket(node: CheckNode): "pass" | "fail" | "pending" | "skipping" {
  if (node.__typename === "CheckRun") {
    if (node.status !== "COMPLETED") return "pending"
    if (node.conclusion === "SUCCESS") return "pass"
    if (node.conclusion === "NEUTRAL" || node.conclusion === "SKIPPED") return "skipping"
    return "fail"
  }
  if (node.state === "SUCCESS") return "pass"
  if (node.state === "FAILURE" || node.state === "ERROR") return "fail"
  return "pending"
}

export function summarizeChecks(contexts: CheckContexts | null | undefined): ChecksSummary {
  const summary: ChecksSummary = {
    overall: "none",
    pass: 0,
    fail: 0,
    pending: 0,
    skipping: 0,
    required_fail: 0,
    required_pending: 0,
    truncated: Boolean(contexts?.pageInfo?.hasNextPage),
  }
  const nodes = (contexts?.nodes ?? []).filter((node): node is CheckNode => node != null)
  for (const node of nodes) {
    const bucket = checkBucket(node)
    summary[bucket]++
    if (node.isRequired && bucket === "fail") summary.required_fail++
    if (node.isRequired && bucket === "pending") summary.required_pending++
  }
  summary.overall = nodes.length === 0 ? "none" : summary.fail ? "fail" : summary.pending ? "pending" : "pass"
  return summary
}
