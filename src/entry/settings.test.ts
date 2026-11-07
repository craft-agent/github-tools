import { describe, expect, test } from "bun:test"
import { isToolError } from "../core"
import {
  forwardedVariables,
  parseSettings,
  parseToolSettings,
  settingsFromOptions,
  settingVariables,
  TOOL_VARIABLES,
} from "./settings"

function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}

describe("settingVariables", () => {
  test("names each setting's variable, in the order the settings are listed", () => {
    expect(settingVariables()).toEqual([
      "GITHUB_TOOLS_TOOLSETS",
      "GITHUB_TOOLS_READ_ONLY",
      "GITHUB_TOOLS_TOOLS",
      "GITHUB_TOOLS_EXCLUDE_TOOLS",
      "GITHUB_TOOLS_CONFIRM",
    ])
  })
})

describe("forwardedVariables", () => {
  test("lists the settings' variables, then the tool variables", () => {
    expect(forwardedVariables(["XDG_STATE_HOME"])).toEqual([...settingVariables(), "XDG_STATE_HOME"])
  })

  test("uses the tool variables by default", () => {
    expect(forwardedVariables()).toEqual([...settingVariables(), ...TOOL_VARIABLES])
  })
})

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
        GITHUB_TOOLS_TOOLSETS: "actions,releases",
        GITHUB_TOOLS_READ_ONLY: "true",
        GITHUB_TOOLS_TOOLS: "x",
        GITHUB_TOOLS_EXCLUDE_TOOLS: "y,z",
        GITHUB_TOOLS_CONFIRM: "elicitation",
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
  ])("GITHUB_TOOLS_READ_ONLY=%s is %p", (value, expected) => {
    expect(parseSettings([], { GITHUB_TOOLS_READ_ONLY: value }).read_only).toBe(expected)
  })

  test.each(["yes", "on", "2", "enabled"])("GITHUB_TOOLS_READ_ONLY=%s is rejected, naming the variable", (value) => {
    const message = failure(() => parseSettings([], { GITHUB_TOOLS_READ_ONLY: value })).message
    expect(message).toContain("GITHUB_TOOLS_READ_ONLY")
    expect(message).toContain(`"${value}"`)
  })

  test("a flag-given --read-only is not blocked by a bad environment variable it overrides", () => {
    expect(parseSettings(["--read-only"], { GITHUB_TOOLS_READ_ONLY: "yes" }).read_only).toBe(true)
  })

  test("a flag wins over its environment variable", () => {
    const env = {
      GITHUB_TOOLS_TOOLSETS: "actions",
      GITHUB_TOOLS_TOOLS: "x",
      GITHUB_TOOLS_EXCLUDE_TOOLS: "y",
      GITHUB_TOOLS_CONFIRM: "elicitation",
      GITHUB_TOOLS_READ_ONLY: "0",
    }
    expect(
      parseSettings(
        ["--toolsets", "issues", "--tools", "a", "--exclude-tools", "b", "--confirm", "harness", "--read-only"],
        env,
      ),
    ).toEqual({ toolsets: ["issues"], tools: ["a"], exclude_tools: ["b"], confirm: "harness", read_only: true })
  })

  test("an empty environment variable counts as unset", () => {
    expect(parseSettings([], { GITHUB_TOOLS_TOOLSETS: "", GITHUB_TOOLS_CONFIRM: " " })).toEqual({
      confirm: "harness",
    })
  })

  test("drops empty list items", () => {
    const settings = parseSettings(["--toolsets", "issues,,pull_requests,", "--tools", ",a, ,b"], {})
    expect(settings.toolsets).toEqual(["issues", "pull_requests"])
    expect(settings.tools).toEqual(["a", "b"])
    expect(parseSettings(["--toolsets", ","], {}).toolsets).toBeUndefined()
  })

  test('"all" turns on every toolset', () => {
    expect(parseSettings(["--toolsets", "all"], {}).toolsets).toBe("all")
    expect(parseSettings([], { GITHUB_TOOLS_TOOLSETS: "all" }).toolsets).toBe("all")
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
    expect(failure(() => parseSettings([], { GITHUB_TOOLS_CONFIRM: "ask" })).message).toContain("GITHUB_TOOLS_CONFIRM")
  })

  test("an unknown toolset is rejected, naming it and where it came from", () => {
    const fromFlag = failure(() => parseSettings(["--toolsets", "issues,bogus"], {})).message
    expect(fromFlag).toContain('"bogus"')
    expect(fromFlag).toContain("--toolsets")
    expect(failure(() => parseSettings([], { GITHUB_TOOLS_TOOLSETS: "bogus" })).message).toContain(
      "GITHUB_TOOLS_TOOLSETS",
    )
  })
})

describe("parseToolSettings", () => {
  test("reads the tool settings and gives no confirm setting", () => {
    expect(parseToolSettings([], {})).toEqual({})
    expect(
      parseToolSettings(["--toolsets=repos", "--read-only", "--tools", "a"], { GITHUB_TOOLS_EXCLUDE_TOOLS: "b" }),
    ).toEqual({
      toolsets: ["repos"],
      read_only: true,
      tools: ["a"],
      exclude_tools: ["b"],
    })
  })

  test("rejects --confirm in both forms, naming it", () => {
    expect(failure(() => parseToolSettings(["--confirm", "harness"], {})).message).toContain("--confirm")
    expect(failure(() => parseToolSettings(["--confirm=elicitation"], {})).message).toContain("--confirm")
  })

  test("ignores GITHUB_TOOLS_CONFIRM, even a bad one", () => {
    expect(parseToolSettings([], { GITHUB_TOOLS_CONFIRM: "ask" })).toEqual({})
  })
})

describe("settingsFromOptions", () => {
  test("gives no setting for no options", () => {
    expect(settingsFromOptions(undefined, {})).toEqual({})
    expect(settingsFromOptions({}, {})).toEqual({})
  })

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
    expect(settingsFromOptions({ toolsets: "all" }, {}).toolsets).toBe("all")
    expect(settingsFromOptions({ toolsets: ["issues", "all"] }, {}).toolsets).toBe("all")
    expect(settingsFromOptions({ toolsets: [] }, {}).toolsets).toBeUndefined()
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

  test("an option of the wrong type is rejected, naming it", () => {
    expect(failure(() => settingsFromOptions({ toolsets: "issues" }, {})).message).toContain('"toolsets"')
    expect(failure(() => settingsFromOptions({ toolsets: [1] }, {})).message).toContain('"toolsets"')
    expect(failure(() => settingsFromOptions({ read_only: "true" }, {})).message).toContain('"read_only"')
    expect(failure(() => settingsFromOptions({ tools: "a" }, {})).message).toContain('"tools"')
    expect(failure(() => settingsFromOptions({ exclude_tools: [null] }, {})).message).toContain('"exclude_tools"')
  })

  test("an unknown toolset or option is rejected, naming it", () => {
    const toolset = failure(() => settingsFromOptions({ toolsets: ["bogus"] }, {})).message
    expect(toolset).toContain('"bogus"')
    expect(toolset).toContain('option "toolsets"')
    expect(failure(() => settingsFromOptions({ confirm: "harness" }, {})).message).toContain('"confirm"')
  })

  test("a bad environment variable is rejected only when no option overrides it", () => {
    expect(failure(() => settingsFromOptions({}, { GITHUB_TOOLS_READ_ONLY: "yes" })).message).toContain(
      "GITHUB_TOOLS_READ_ONLY",
    )
    expect(settingsFromOptions({ read_only: true }, { GITHUB_TOOLS_READ_ONLY: "yes" }).read_only).toBe(true)
  })
})
