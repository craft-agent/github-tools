import { describe, expect, test } from "bun:test"
import { BOARD_FIELD_NODES } from "../../testing/board-write-fixtures"
import { toField } from "./board-fields"
import { isEmptyValue, isHeld, planClears, planFieldValues } from "./board-field-values"

const FIELDS = BOARD_FIELD_NODES.map((node) => toField(node as Parameters<typeof toField>[0]))
const NOW = new Date("2026-11-05T23:59:59Z")

function message(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected a failure")
}

describe("planFieldValues", () => {
  test("resolves each kind of value to what is sent and what is reported", () => {
    const writes = planFieldValues(FIELDS, {
      notes: "  hello ",
      ESTIMATE: "3.5",
      Target: "2026-12-01",
      status: "waiting",
      Sprint: "sprint 2",
    })
    expect(writes.map(({ field, kind, sent, shown }) => [field.name, kind, sent, shown])).toEqual([
      ["Notes", "text", "  hello ", "  hello "],
      ["Estimate", "number", 3.5, 3.5],
      ["Target", "date", "2026-12-01", "2026-12-01"],
      ["Status", "single_select", "O_wait", "Waiting"],
      ["Sprint", "iteration", "IT_2", "Sprint 2"],
    ])
  })

  test("a number may be given as a number", () => {
    expect(planFieldValues(FIELDS, { Estimate: -2 })[0]).toMatchObject({ sent: -2, shown: -2 })
  })

  test("@current is the iteration that contains today in UTC", () => {
    expect(planFieldValues(FIELDS, { Sprint: "@current" }, NOW)[0]).toMatchObject({ sent: "IT_1", shown: "Sprint 1" })
    const later = new Date("2026-11-16T00:00:00Z")
    expect(planFieldValues(FIELDS, { Sprint: "@CURRENT" }, later)[0]).toMatchObject({ sent: "IT_2" })
    expect(message(() => planFieldValues(FIELDS, { Sprint: "@current" }, new Date("2027-01-01T00:00:00Z")))).toContain(
      "No iteration contains today",
    )
  })

  test.each([
    ["an unknown field", { Nope: "x" }, 'The board has no field "Nope". Fields that can be set: "Status", "Notes"'],
    [
      "an unknown option",
      { Status: "Blocked" },
      '"Status" has no option "Blocked". Options: "Todo", "Waiting", "Done"',
    ],
    ["an unknown iteration", { Sprint: "Sprint 9" }, 'No iteration "Sprint 9" in "Sprint". Iterations: "Sprint 1"'],
    ["a date in another form", { Target: "12/01/2026" }, '"Target" takes a date as YYYY-MM-DD'],
    ["a date that does not exist", { Target: "2026-02-30" }, '"Target" takes a date as YYYY-MM-DD'],
    ["a number that is not one", { Estimate: "3 points" }, '"Estimate" takes a number'],
    ["an infinite number", { Estimate: Infinity }, '"Estimate" takes a number'],
    ["a number for a text field", { Notes: 5 }, '"Notes" takes text as text; got the number 5'],
    ["a number for an option", { Status: 1 }, '"Status" takes an option name as text'],
    ["a field named twice", { status: "Todo", Status: "Done" }, 'fields names "Status" twice'],
  ])("%s is invalid_argument naming the valid choices", (_, values, expected) => {
    expect(message(() => planFieldValues(FIELDS, values))).toContain(expected)
  })

  test.each([
    ["Title", false],
    ["Assignees", true],
    ["Milestone", true],
  ])("%s is GitHub's own field", (name, hintsIssueEdit) => {
    const text = message(() => planFieldValues(FIELDS, { [name]: "x" }))
    expect(text).toContain(`"${name}" is one of GitHub's own fields`)
    expect(text.includes("github_issue_edit sets assignees, labels and milestone")).toBe(hintsIssueEdit)
  })

  test.each([
    ["Priority", "High"],
    ["Target date", "2026-12-01"],
  ])("refuses setting issue field %s with instructions pointing to issue tools", (name, value) => {
    const text = message(() => planFieldValues(FIELDS, { [name]: value }))
    expect(text).toBe(
      `"${name}" mirrors the organization's issue field; its value is the issue's own and cannot be set on a board. Set it with issue_fields in github_issue_edit or github_issue_create. Fields that can be set: "Status", "Notes", "Estimate", "Target", "Sprint".`,
    )
  })

  test("unknown field error leaves out issue_field columns from fields that can be set", () => {
    const text = message(() => planFieldValues(FIELDS, { Unknown: "val" }))
    expect(text).toBe(
      'The board has no field "Unknown". Fields that can be set: "Status", "Notes", "Estimate", "Target", "Sprint".',
    )
  })
})

describe("planClears", () => {
  test("names the fields to empty, once each, and refuses GitHub's own", () => {
    expect(planClears(FIELDS, ["target", "TARGET", "Notes"]).map((field) => field.name)).toEqual(["Target", "Notes"])
    expect(message(() => planClears(FIELDS, ["Title"]))).toContain("GitHub's own")
    expect(message(() => planClears(FIELDS, ["Nope"]))).toContain('no field "Nope"')
  })

  test.each(["Priority", "Target date"])(
    "refuses clearing issue field %s with instructions pointing to github_issue_edit",
    (name) => {
      const text = message(() => planClears(FIELDS, [name]))
      expect(text).toBe(
        `"${name}" mirrors the organization's issue field; its value is the issue's own and cannot be cleared on a board. Clear it with clear_issue_fields in github_issue_edit. Fields that can be set: "Status", "Notes", "Estimate", "Target", "Sprint".`,
      )
    },
  )
})

describe("comparing with what an item holds", () => {
  const [estimate, status, sprint] = planFieldValues(FIELDS, { Estimate: 3, Status: "Done", Sprint: "Sprint 2" })

  test("a value is held when it equals the current one, an iteration by its title", () => {
    expect(isHeld(estimate!, 3)).toBe(true)
    expect(isHeld(estimate!, 4)).toBe(false)
    expect(isHeld(status!, "Done")).toBe(true)
    expect(isHeld(status!, "Todo")).toBe(false)
    expect(isHeld(sprint!, { title: "Sprint 2", start_date: "2026-11-16", duration: 14 })).toBe(true)
    expect(isHeld(sprint!, { title: "Sprint 1", start_date: "2026-11-02", duration: 14 })).toBe(false)
    expect(isHeld(sprint!, undefined)).toBe(false)
  })

  test("only a missing or null value is empty", () => {
    expect([undefined, null, "", 0].map(isEmptyValue)).toEqual([true, true, false, false])
  })
})
