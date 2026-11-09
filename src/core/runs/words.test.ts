import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { runCancel } from "./run-cancel"
import { runRead } from "./run-read"
import { runRerun } from "./run-rerun"
import { RUN_TRANSLATIONS } from "./words"

describe("RUN_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    expect(Object.keys(RUN_TRANSLATIONS.ja!).sort()).toEqual(toolWords([runRead, runRerun, runCancel]))
  })
})
