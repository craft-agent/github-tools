import { describe, expect, test } from "bun:test"
import { toolWords } from "../../testing/tool-words"
import { labelCreate } from "./label-create"
import { labelDelete } from "./label-delete"
import { labelEdit } from "./label-edit"
import { labelRead } from "./label-read"
import { milestoneCreate } from "./milestone-create"
import { milestoneEdit } from "./milestone-edit"
import { milestoneRead } from "./milestone-read"
import { repoArchive } from "./repo-archive"
import { repoCreate } from "./repo-create"
import { repoEdit } from "./repo-edit"
import { repoRead } from "./repo-read"
import { repoUnarchive } from "./repo-unarchive"
import { repoVisibility } from "./repo-visibility"
import { rulesetCreate } from "./ruleset-create"
import { rulesetDelete } from "./ruleset-delete"
import { rulesetEdit } from "./ruleset-edit"
import { rulesetRead } from "./ruleset-read"
import { REPO_TRANSLATIONS } from "./words"

describe("REPO_TRANSLATIONS", () => {
  test("translates exactly the titles and intents of the write tools", () => {
    const specs = [
      repoRead,
      labelRead,
      milestoneRead,
      rulesetRead,
      labelCreate,
      labelEdit,
      labelDelete,
      milestoneCreate,
      milestoneEdit,
      repoCreate,
      repoEdit,
      repoVisibility,
      repoArchive,
      repoUnarchive,
      rulesetCreate,
      rulesetEdit,
      rulesetDelete,
    ]
    expect(Object.keys(REPO_TRANSLATIONS.ja!).sort()).toEqual(toolWords(specs))
  })
})
