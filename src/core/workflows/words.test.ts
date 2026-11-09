import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { workflowRead } from "./workflow-read"
import { workflowRun } from "./workflow-run"
import { WORKFLOW_TRANSLATIONS } from "./words"

describe("WORKFLOW_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    expect(Object.keys(WORKFLOW_TRANSLATIONS.ja!).sort()).toEqual(toolWords([workflowRead, workflowRun]))
  })
})
