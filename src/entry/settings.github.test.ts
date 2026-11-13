import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { PROJECT_PROFILE } from "./profile"
import { languageVariable, parseSettings, settingsFromOptions, settingVariables } from "./settings"

const DEFAULT_GRANTS = {
  unattended: false,
  dir: join(homedir(), ".local", "state", PROJECT_PROFILE.name, "grants"),
  key: undefined,
}

describe("the package settings profile", () => {
  test("reads each GITHUB_TOOLS variable", () => {
    expect(settingVariables()).toEqual([
      "GITHUB_TOOLS_TOOLSETS",
      "GITHUB_TOOLS_READ_ONLY",
      "GITHUB_TOOLS_TOOLS",
      "GITHUB_TOOLS_EXCLUDE_TOOLS",
      "GITHUB_TOOLS_CONFIRM",
      "GITHUB_TOOLS_UNATTENDED",
      "GITHUB_TOOLS_GRANTS_DIR",
    ])
    const env = {
      GITHUB_TOOLS_TOOLSETS: "actions,releases",
      GITHUB_TOOLS_READ_ONLY: "true",
      GITHUB_TOOLS_TOOLS: "github_repo_read",
      GITHUB_TOOLS_EXCLUDE_TOOLS: "github_pr_merge",
      GITHUB_TOOLS_CONFIRM: "elicitation",
      GITHUB_TOOLS_LANGUAGE: "ja",
      GITHUB_TOOLS_UNATTENDED: "true",
      GITHUB_TOOLS_GRANTS_DIR: "/srv/grants",
    }
    expect(parseSettings([], env)).toEqual({
      toolsets: ["actions", "releases"],
      read_only: true,
      tools: ["github_repo_read"],
      exclude_tools: ["github_pr_merge"],
      confirm: "elicitation",
      options: {},
      grants: { unattended: true, dir: "/srv/grants", key: undefined },
    })
    expect(languageVariable()).toBe("GITHUB_TOOLS_LANGUAGE")
    expect(settingsFromOptions({}, env).language).toBe("ja")
  })

  test("defines the seven toolsets, three defaults and all", () => {
    const names = ["issues", "pull_requests", "projects", "repos", "releases", "actions", "grants"]
    expect(PROJECT_PROFILE.toolsets.names).toEqual(names)
    expect(PROJECT_PROFILE.toolsets.defaults).toEqual(["issues", "pull_requests", "projects"])
    expect(parseSettings(["--toolsets", names.join(",")], {}).toolsets).toEqual(names)
    expect(parseSettings(["--toolsets", "all"], {}).toolsets).toBe("all")
  })

  test("reads options with the package profile", () => {
    expect(
      settingsFromOptions(
        {
          toolsets: ["issues", "projects"],
          read_only: true,
          tools: ["github_repo_read"],
          exclude_tools: ["github_pr_merge"],
        },
        {},
      ),
    ).toEqual({
      toolsets: ["issues", "projects"],
      read_only: true,
      tools: ["github_repo_read"],
      exclude_tools: ["github_pr_merge"],
      options: {},
      grants: DEFAULT_GRANTS,
    })
  })
})
