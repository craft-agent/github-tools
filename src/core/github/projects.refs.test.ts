import { describe, expect, test } from "bun:test"
import { board } from "../../testing/project-fixtures"
import { isToolError, type ToolError } from "../errors"
import { assertBoardWritable, boardResource, parseBoardProject, parseBoardRef, type BoardRef } from "./projects"

/** The `ToolError` a synchronous call throws. */
function thrownBy(fn: () => unknown): ToolError {
  try {
    fn()
  } catch (error) {
    if (isToolError(error)) return error
    throw error
  }
  throw new Error("expected a ToolError, but nothing was thrown")
}

const REFERENCES: [string, BoardRef][] = [
  ["3", { number: 3 }],
  [" 12 ", { number: 12 }],
  ["octo/3", { owner: "octo", number: 3 }],
  ["Octo_emu/7", { owner: "Octo_emu", number: 7 }],
  ["https://github.com/orgs/octo/projects/3", { owner: "octo", number: 3 }],
  ["https://github.com/users/alice/projects/4", { owner: "alice", number: 4 }],
  ["https://github.com/orgs/octo/projects/3/views/2", { owner: "octo", number: 3 }],
  ["https://github.com/orgs/octo/projects/3/views/2?layout=table&filterQuery=x", { owner: "octo", number: 3 }],
  ["https://github.com/users/alice/projects/4?pane=issue#top", { owner: "alice", number: 4 }],
]

/** Values that are no reference, so a `project` argument holding one is a title. */
const TITLES = [
  "Roadmap",
  "Q4 plan",
  "octo",
  "octo/hello#3",
  "octo/three",
  "a b/3",
  "octo/projects/3",
  "-3",
  "#3",
  "3.5",
  "https://github.com/octo/projects/3",
  "https://github.com/orgs/octo/projects",
  "https://github.com/orgs/octo/projects/x",
  "https://github.com/orgs/octo/projects/3/insights",
  "https://github.com/orgs/octo/projects/3/views",
  "https://gitlab.com/orgs/octo/projects/3",
  "http://github.com/orgs/octo/projects/3",
]

/** Digits that cannot be a board's number. */
const BAD_NUMBERS = ["0", "99999999999999999999"]

describe("parseBoardRef", () => {
  test.each(REFERENCES)("%s", (value, expected) => {
    expect(parseBoardRef(value)).toEqual(expected)
  })

  test.each(["", ...TITLES, ...BAD_NUMBERS])("%p is invalid_argument", (value) => {
    expect(thrownBy(() => parseBoardRef(value)).code).toBe("invalid_argument")
  })
})

describe("parseBoardProject", () => {
  test.each(REFERENCES)("%s is a reference", (value, expected) => {
    expect(parseBoardProject(value)).toEqual({ ref: expected })
  })

  test.each(TITLES)("%p is a title", (value) => {
    expect(parseBoardProject(value)).toEqual({ title: value })
  })

  test("a title is trimmed, and keeps its case", () => {
    expect(parseBoardProject("  Q4 Plan ")).toEqual({ title: "Q4 Plan" })
  })

  test.each(["", " ", "\n\t"])("blank %p is invalid_argument", (value) => {
    const error = thrownBy(() => parseBoardProject(value))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("project")
  })

  test.each(BAD_NUMBERS)("digits that cannot be a board number (%s) stay invalid_argument, not a title", (value) => {
    expect(thrownBy(() => parseBoardProject(value)).code).toBe("invalid_argument")
  })
})

describe("boardResource and assertBoardWritable", () => {
  test("a board is owner/projects/N with the owner in lower case", () => {
    expect(boardResource({ owner: "Octo", number: 7 })).toBe("octo/projects/7")
  })

  test("a board the viewer may update passes", () => {
    expect(() => assertBoardWritable(board(7))).not.toThrow()
  })

  test("a board the viewer may not update is forbidden, named", () => {
    const error = thrownBy(() => assertBoardWritable(board(7, { can_update: false, owner: "Octo" })))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("cannot update octo/projects/7")
  })
})
