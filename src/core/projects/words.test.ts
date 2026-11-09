import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { projectCreate } from "./create"
import { projectFieldEnsure } from "./field-ensure"
import { projectItemAdd } from "./item-add"
import { projectItemArchive, projectItemUnarchive } from "./item-archive"
import { projectItemConvert } from "./item-convert"
import { projectItemCreate } from "./item-create"
import { projectItemEdit } from "./item-edit"
import { projectLink, projectUnlink } from "./link"
import { projectRead } from "./read"
import { projectViewEnsure } from "./view-ensure"
import { PROJECT_TRANSLATIONS } from "./words"

describe("PROJECT_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    const specs = [
      projectRead,
      projectCreate,
      projectLink,
      projectUnlink,
      projectFieldEnsure,
      projectViewEnsure,
      projectItemAdd,
      projectItemCreate,
      projectItemEdit,
      projectItemArchive,
      projectItemUnarchive,
      projectItemConvert,
    ]
    expect(Object.keys(PROJECT_TRANSLATIONS.ja!).sort()).toEqual(toolWords(specs))
  })
})
