import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { releaseCreate } from "./release-create"
import { releaseDelete } from "./release-delete"
import { releaseEdit } from "./release-edit"
import { releasePublish } from "./release-publish"
import { releaseRead } from "./release-read"
import { RELEASE_TRANSLATIONS } from "./words"

describe("RELEASE_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    const specs = [releaseRead, releaseCreate, releaseEdit, releaseDelete, releasePublish]
    expect(Object.keys(RELEASE_TRANSLATIONS.ja!).sort()).toEqual(toolWords(specs))
  })
})
