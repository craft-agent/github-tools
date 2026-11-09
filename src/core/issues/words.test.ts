import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { issueClose } from "./close"
import { issueComment } from "./comment"
import { issueCreate } from "./create"
import { issueDevelop } from "./develop"
import { issueEdit } from "./edit"
import { issueRead } from "./read"
import { issueRelate } from "./relate"
import { issueReopen } from "./reopen"
import { ISSUE_TRANSLATIONS } from "./words"

describe("ISSUE_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    const specs = [issueRead, issueCreate, issueEdit, issueComment, issueClose, issueReopen, issueRelate, issueDevelop]
    expect(Object.keys(ISSUE_TRANSLATIONS.ja!).sort()).toEqual(toolWords(specs))
  })
})
