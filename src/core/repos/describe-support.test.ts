import { describe, expect, test } from "bun:test"
import { installFakeGh } from "../../testing/fake-gh"
import { tempRepo } from "../../testing/git-repo"
import { ORIGIN } from "../../testing/write-fixtures"
import { repoRules } from "./describe.fixtures"
import { describedRepo, repoHeadline, transitionFact, visibilityFact } from "./describe-support"

/** Resolves the repository `repo` names (the working tree's when none) against the replies in `rules`. */
async function resolve(repo: string | undefined, rules: ReturnType<typeof repoRules>) {
  const dir = tempRepo(ORIGIN)
  const fake = installFakeGh(rules)
  try {
    return await describedRepo({ repo }, { cwd: dir.dir })
  } finally {
    fake.restore()
    dir.cleanup()
  }
}

describe("describedRepo", () => {
  test("gives the repository as GitHub spells it, with its visibility, archive state and default branch", async () => {
    const { view, target } = await resolve(undefined, repoRules({ visibility: "PRIVATE", isArchived: true }))
    expect(view).toMatchObject({ repo: "octo/hello", visibility: "private", archived: true, default_branch: "main" })
    expect(target.full).toBe("octo/hello")
  })

  test("refuses a repository the viewer does not administer, as execute does", async () => {
    await expect(resolve("octo/hello", repoRules({ viewerPermission: "READ" }))).rejects.toMatchObject({
      code: "forbidden",
    })
  })
})

describe("repoHeadline", () => {
  test("puts the full name in the template's values", () => {
    expect(repoHeadline("About to do {name}", "octo/hello")).toEqual({
      headline: { text: "About to do {name}", values: { name: "octo/hello" } },
    })
  })
})

describe("visibilityFact and transitionFact", () => {
  test("word the visibility and each change of it as a template value", () => {
    expect(visibilityFact("internal")).toEqual({ label: "Visibility", value: { text: "Internal" } })
    expect(transitionFact("public", "internal")).toEqual({ label: "Visibility", value: { text: "Public to internal" } })
    expect(transitionFact("internal", "private")).toEqual({
      label: "Visibility",
      value: { text: "Internal to private" },
    })
  })
})
