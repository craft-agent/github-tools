import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { refusalAsInvalid } from "./refusal"

const failing = (error: unknown) => () => Promise.reject(error)

describe("refusalAsInvalid", () => {
  test.each([
    [
      "gh failed (exit 1): gh: Visibility Only organizations associated with an enterprise can set visibility to internal (HTTP 422)",
      "GitHub refused it: Visibility Only organizations associated with an enterprise can set visibility to internal.",
    ],
    [
      "gh failed (exit 1): gh: Validation Failed (HTTP 422): name already exists on this account; Another",
      "GitHub refused it: Validation Failed: name already exists on this account; Another.",
    ],
    ["gh failed (exit 1): HTTP 422: type is invalid", "GitHub refused it: type is invalid."],
    ["gh failed (exit 1): gh: Unprocessable Entity (HTTP 422).", "GitHub refused it: Unprocessable Entity."],
    ["gh failed (exit 1): gh: (HTTP 422)", "GitHub refused it."],
  ])("maps %p to invalid_argument", async (message, expected) => {
    const cause = new ToolError("github_error", message)
    const error = await refusalAsInvalid(failing(cause)).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect((error as ToolError).message).toBe(expected)
    expect((error as ToolError).cause).toBe(cause)
  })

  test.each([
    new ToolError("forbidden", "gh failed (exit 1): gh: Forbidden (HTTP 403)"),
    new ToolError("not_found", "gh failed (exit 1): gh: Not Found (HTTP 404)"),
    new ToolError("stale", "gh failed (exit 1): gh: Conflict (HTTP 409)"),
    new ToolError("github_error", "gh failed (exit 1): gh: Server Error (HTTP 500)"),
    new ToolError("invalid_argument", "gh failed (exit 1): gh: Unprocessable Entity (HTTP 422)"),
    new Error("HTTP 422"),
  ])("leaves %p as it is", async (cause) => {
    expect(await refusalAsInvalid(failing(cause)).catch((thrown: unknown) => thrown)).toBe(cause)
  })

  test("returns what the write returned", async () => {
    expect(await refusalAsInvalid(async () => 7)).toBe(7)
  })
})
