import { describe, expect, test } from "bun:test"
import { isToolError } from "../core"
import { parseSettings } from "./settings"

function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}

describe("parseSettings", () => {
  test("defaults to the harness confirming and no other setting", () => {
    expect(parseSettings([], {})).toEqual({ confirm: "harness" })
  })

  test("reads each flag", () => {
    expect(
      parseSettings(
        [
          "--toolsets",
          "issues,projects",
          "--read-only",
          "--tools",
          "github_repo_read",
          "--exclude-tools",
          "github_pr_merge",
          "--confirm",
          "elicitation",
        ],
        {},
      ),
    ).toEqual({
      toolsets: ["issues", "projects"],
      read_only: true,
      tools: ["github_repo_read"],
      exclude_tools: ["github_pr_merge"],
      confirm: "elicitation",
    })
  })

  test("reads the --flag=value form", () => {
    expect(
      parseSettings(
        ["--toolsets=repos", "--tools=a,b", "--exclude-tools=c", "--confirm=elicitation", "--read-only"],
        {},
      ),
    ).toEqual({
      toolsets: ["repos"],
      tools: ["a", "b"],
      exclude_tools: ["c"],
      read_only: true,
      confirm: "elicitation",
    })
  })

  test("falls back to the environment", () => {
    expect(
      parseSettings([], {
        AGENT_GITHUB_TOOLSETS: "actions,releases",
        AGENT_GITHUB_READ_ONLY: "true",
        AGENT_GITHUB_TOOLS: "x",
        AGENT_GITHUB_EXCLUDE_TOOLS: "y,z",
        AGENT_GITHUB_CONFIRM: "elicitation",
      }),
    ).toEqual({
      toolsets: ["actions", "releases"],
      read_only: true,
      tools: ["x"],
      exclude_tools: ["y", "z"],
      confirm: "elicitation",
    })
  })

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["False", false],
  ])("AGENT_GITHUB_READ_ONLY=%s is %p", (value, expected) => {
    expect(parseSettings([], { AGENT_GITHUB_READ_ONLY: value }).read_only).toBe(expected)
  })

  test.each(["yes", "on", "2", "enabled"])("AGENT_GITHUB_READ_ONLY=%s is rejected, naming the variable", (value) => {
    const message = failure(() => parseSettings([], { AGENT_GITHUB_READ_ONLY: value })).message
    expect(message).toContain("AGENT_GITHUB_READ_ONLY")
    expect(message).toContain(`"${value}"`)
  })

  test("a flag-given --read-only is not blocked by a bad environment variable it overrides", () => {
    expect(parseSettings(["--read-only"], { AGENT_GITHUB_READ_ONLY: "yes" }).read_only).toBe(true)
  })

  test("a flag wins over its environment variable", () => {
    const env = {
      AGENT_GITHUB_TOOLSETS: "actions",
      AGENT_GITHUB_TOOLS: "x",
      AGENT_GITHUB_EXCLUDE_TOOLS: "y",
      AGENT_GITHUB_CONFIRM: "elicitation",
      AGENT_GITHUB_READ_ONLY: "0",
    }
    expect(
      parseSettings(
        ["--toolsets", "issues", "--tools", "a", "--exclude-tools", "b", "--confirm", "harness", "--read-only"],
        env,
      ),
    ).toEqual({ toolsets: ["issues"], tools: ["a"], exclude_tools: ["b"], confirm: "harness", read_only: true })
  })

  test("an empty environment variable counts as unset", () => {
    expect(parseSettings([], { AGENT_GITHUB_TOOLSETS: "", AGENT_GITHUB_CONFIRM: " " })).toEqual({ confirm: "harness" })
  })

  test("drops empty list items", () => {
    const settings = parseSettings(["--toolsets", "issues,,pull_requests,", "--tools", ",a, ,b"], {})
    expect(settings.toolsets).toEqual(["issues", "pull_requests"])
    expect(settings.tools).toEqual(["a", "b"])
    expect(parseSettings(["--toolsets", ","], {}).toolsets).toBeUndefined()
  })

  test('"all" turns on every toolset', () => {
    expect(parseSettings(["--toolsets", "all"], {}).toolsets).toBe("all")
    expect(parseSettings([], { AGENT_GITHUB_TOOLSETS: "all" }).toolsets).toBe("all")
  })

  test("the last of a repeated flag wins", () => {
    expect(parseSettings(["--confirm", "elicitation", "--confirm=harness"], {}).confirm).toBe("harness")
  })

  test("an unknown flag or a stray argument is rejected, naming it", () => {
    expect(failure(() => parseSettings(["--nope"], {})).message).toContain("--nope")
    expect(failure(() => parseSettings(["--nope=1"], {})).message).toContain("--nope=1")
    expect(failure(() => parseSettings(["issues"], {})).message).toContain("issues")
  })

  test("a flag without a value is rejected, naming it", () => {
    expect(failure(() => parseSettings(["--toolsets"], {})).message).toContain("--toolsets")
    expect(failure(() => parseSettings(["--tools", "--read-only"], {})).message).toContain("--tools")
    expect(failure(() => parseSettings(["--read-only=1"], {})).message).toContain("--read-only")
  })

  test("a bad confirm mode is rejected, naming it", () => {
    expect(failure(() => parseSettings(["--confirm", "ask"], {})).message).toContain('"ask"')
    expect(failure(() => parseSettings([], { AGENT_GITHUB_CONFIRM: "ask" })).message).toContain("AGENT_GITHUB_CONFIRM")
  })

  test("an unknown toolset is rejected, naming it and where it came from", () => {
    const fromFlag = failure(() => parseSettings(["--toolsets", "issues,bogus"], {})).message
    expect(fromFlag).toContain('"bogus"')
    expect(fromFlag).toContain("--toolsets")
    expect(failure(() => parseSettings([], { AGENT_GITHUB_TOOLSETS: "bogus" })).message).toContain(
      "AGENT_GITHUB_TOOLSETS",
    )
  })
})
