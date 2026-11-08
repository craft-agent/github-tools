import { describe, expect, test } from "bun:test"
import { isToolError } from "../core"
import {
  LANGUAGE_VARIABLE,
  parseSettings,
  parseToolSettings,
  promptLanguage,
  settingsFromOptions,
  settingVariables,
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

const fromOptions = (options: Record<string, unknown> | undefined, env: Record<string, string | undefined> = {}) =>
  settingsFromOptions(options, env)

describe("LANGUAGE_VARIABLE", () => {
  test("is GITHUB_TOOLS_LANGUAGE, and no setting variable", () => {
    expect(LANGUAGE_VARIABLE).toBe("GITHUB_TOOLS_LANGUAGE")
    expect(settingVariables()).not.toContain(LANGUAGE_VARIABLE)
  })
})

describe("settingsFromOptions language", () => {
  test("reads the option trimmed, and treats blank as unset", () => {
    expect(fromOptions({ language: "ja" })).toEqual({ language: "ja" })
    expect(fromOptions({ language: " ja-JP " }).language).toBe("ja-JP")
    expect(fromOptions({ language: "  " })).toEqual({})
    expect(fromOptions({ language: "xx-unknown" }).language).toBe("xx-unknown")
  })

  test("rejects a value that is not a string", () => {
    const message = failure(() => fromOptions({ language: 1 })).message
    expect(message).toBe('Option "language" must be a language tag such as "ja".')
  })

  test("falls back to the environment, and an option wins over it", () => {
    expect(fromOptions({}, { GITHUB_TOOLS_LANGUAGE: " fr " }).language).toBe("fr")
    expect(fromOptions({}, { GITHUB_TOOLS_LANGUAGE: " " })).toEqual({})
    expect(fromOptions({ language: "ja" }, { GITHUB_TOOLS_LANGUAGE: "fr" }).language).toBe("ja")
  })

  test("the unknown-option message lists language", () => {
    expect(failure(() => fromOptions({ bogus: 1 })).message).toContain("language")
  })
})

describe("the command-line parsers", () => {
  test("reject --language as an unknown option", () => {
    expect(failure(() => parseSettings(["--language", "ja"], {})).message).toContain("--language")
    expect(failure(() => parseToolSettings(["--language=ja"], {})).message).toContain("--language")
  })

  test("ignore the language variable", () => {
    const env = { GITHUB_TOOLS_LANGUAGE: "ja" }
    expect(parseSettings([], env)).toEqual({ confirm: "harness" })
    expect(parseToolSettings([], env)).toEqual({})
  })
})

describe("promptLanguage", () => {
  const env = { GITHUB_TOOLS_LANGUAGE: "fr" }

  test("prefers the flag, then the environment, then the harness", () => {
    expect(promptLanguage("ja", env, "de")).toBe("ja")
    expect(promptLanguage(undefined, env, "de")).toBe("fr")
    expect(promptLanguage(undefined, {}, "de")).toBe("de")
  })

  test("skips blank values and trims", () => {
    expect(promptLanguage(" ", env, "de")).toBe("fr")
    expect(promptLanguage(undefined, { GITHUB_TOOLS_LANGUAGE: "" }, " de ")).toBe("de")
    expect(promptLanguage(" ja ", {}, undefined)).toBe("ja")
  })

  test("is undefined when nothing is set", () => {
    expect(promptLanguage(undefined, {}, undefined)).toBeUndefined()
    expect(promptLanguage(" ", { GITHUB_TOOLS_LANGUAGE: " " }, "")).toBeUndefined()
  })
})
