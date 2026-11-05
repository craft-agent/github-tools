import { expect, test } from "bun:test"
import { checkBucket, summarizeChecks, type CheckNode } from "./checks"

const run = (conclusion: string | null, status = "COMPLETED", isRequired = false): CheckNode => ({
  __typename: "CheckRun",
  status,
  conclusion,
  isRequired,
})
const status = (state: string, isRequired = false): CheckNode => ({ __typename: "StatusContext", state, isRequired })

test.each([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "UNKNOWN",
  null,
])("completed run %p", (conclusion) => {
  expect(checkBucket(run(conclusion))).toBe(
    conclusion === "SUCCESS" ? "pass" : conclusion === "NEUTRAL" || conclusion === "SKIPPED" ? "skipping" : "fail",
  )
})

test.each(["IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED", "PENDING"])("unfinished run %s is pending", (state) => {
  expect(checkBucket(run("SUCCESS", state))).toBe("pending")
})

test.each(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED", "UNKNOWN"])("status context %s", (state) => {
  expect(checkBucket(status(state))).toBe(
    state === "SUCCESS" ? "pass" : state === "FAILURE" || state === "ERROR" ? "fail" : "pending",
  )
})

test("counts buckets and required checks, and reports truncation", () => {
  expect(
    summarizeChecks({
      nodes: [
        run("CANCELLED", "COMPLETED", true),
        status("ERROR"),
        status("EXPECTED", true),
        run(null, "IN_PROGRESS"),
        run("NEUTRAL"),
        status("SUCCESS"),
        null,
      ],
      pageInfo: { hasNextPage: true },
    }),
  ).toEqual({
    overall: "fail",
    pass: 1,
    fail: 2,
    pending: 2,
    skipping: 1,
    required_fail: 1,
    required_pending: 1,
    truncated: true,
  })
})

test("overall none, fail, pending and pass", () => {
  expect(summarizeChecks(undefined).overall).toBe("none")
  expect(summarizeChecks({ nodes: [] }).overall).toBe("none")
  expect(summarizeChecks({ nodes: [status("ERROR"), status("PENDING")] }).overall).toBe("fail")
  expect(summarizeChecks({ nodes: [status("SUCCESS"), status("PENDING")] }).overall).toBe("pending")
  expect(summarizeChecks({ nodes: [status("SUCCESS"), run("SKIPPED")] }).overall).toBe("pass")
  expect(summarizeChecks({ nodes: [run("NEUTRAL")] }).overall).toBe("pass")
  expect(summarizeChecks(null).truncated).toBe(false)
})
