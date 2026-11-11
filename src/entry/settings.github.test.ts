import { describe, expect, test } from "bun:test"
import { settingsFromOptions } from "./settings"
import { failure } from "./settings.testing"

describe("settingsFromOptions with the package profile", () => {
  test("reads each option", () => {
    expect(
      settingsFromOptions(
        { toolsets: ["issues", "projects"], read_only: true, tools: ["github_repo_read"], exclude_tools: ["a"] },
        {},
      ),
    ).toEqual({
      toolsets: ["issues", "projects"],
      read_only: true,
      tools: ["github_repo_read"],
      exclude_tools: ["a"],
    })
    expect(settingsFromOptions({ toolsets: ["issues", "all"] }, {}).toolsets).toBe("all")
  })

  test("falls back to the environment, and an option wins over it", () => {
    const env = {
      GITHUB_TOOLS_TOOLSETS: "actions",
      GITHUB_TOOLS_READ_ONLY: "true",
      GITHUB_TOOLS_TOOLS: "a,b",
    }
    expect(settingsFromOptions({}, env)).toEqual({ toolsets: ["actions"], read_only: true, tools: ["a", "b"] })
    expect(
      settingsFromOptions({ toolsets: ["repos"], read_only: false }, { ...env, GITHUB_TOOLS_READ_ONLY: "yes" }),
    ).toEqual({ toolsets: ["repos"], read_only: false, tools: ["a", "b"] })
  })

  test("a bad environment variable is rejected only when no option overrides it", () => {
    expect(failure(() => settingsFromOptions({}, { GITHUB_TOOLS_READ_ONLY: "yes" })).message).toContain(
      "GITHUB_TOOLS_READ_ONLY",
    )
    expect(settingsFromOptions({ read_only: true }, { GITHUB_TOOLS_READ_ONLY: "yes" }).read_only).toBe(true)
  })
})
