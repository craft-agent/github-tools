import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { prClose } from "./close"
import { prComment } from "./comment"
import { prCreate } from "./create"
import { prEdit } from "./edit"
import { prMerge } from "./merge"
import { prRead } from "./read"
import { prReady } from "./ready"
import { prReopen } from "./reopen"
import { prReview } from "./review"
import { stackLink } from "./stack-link"
import { stackRead } from "./stack-read"
import { stackUnlink } from "./stack-unlink"
import { PULL_REQUEST_TRANSLATIONS } from "./words"

describe("PULL_REQUEST_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    const specs = [
      prRead,
      prCreate,
      prEdit,
      prComment,
      prReady,
      prClose,
      prReopen,
      prReview,
      prMerge,
      stackRead,
      stackLink,
      stackUnlink,
    ]
    expect(Object.keys(PULL_REQUEST_TRANSLATIONS.ja!).sort()).toEqual(toolWords(specs))
  })
})
