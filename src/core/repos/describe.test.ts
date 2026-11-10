import { describe, expect, test } from "bun:test"
import { queryOf } from "../../testing/setup-fixtures"
import { MAX_FACTS, MAX_HEADLINE_LENGTH, MAX_LABEL_LENGTH } from "../describe"
import { NOT_ARCHIVED } from "../write-facts"
import { DESCRIBE_CASES, describeCase, repoRules, type DescribeCase } from "./describe.fixtures"

/** The methods of a `gh api` call that change something. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

const named = (text: string) => ({ text, values: { name: "octo/hello" } })
const visibility = (word: string) => ({ label: "Visibility", value: { text: word } })

describe("github_repo_archive", () => {
  const headline = named("About to archive the repository {name}")

  test("names the repository as GitHub spells it and shows the visibility it keeps", async () => {
    expect(await describeCase(DESCRIBE_CASES.archive)).toEqual({ headline, facts: [visibility("Public")] })
  })

  test("a repository named by owner/name is the same", async () => {
    expect(await describeCase(DESCRIBE_CASES.archivePrivate)).toEqual({ headline, facts: [visibility("Private")] })
  })

  test("an internal repository shows Internal", async () => {
    expect((await describeCase(DESCRIBE_CASES.archiveInternal))?.facts).toEqual([visibility("Internal")])
  })

  test.each([
    ["a repository that is archived already", DESCRIBE_CASES.archive.args, repoRules({ isArchived: true })],
    [
      "a repository the viewer does not administer",
      DESCRIBE_CASES.archive.args,
      repoRules({ viewerPermission: "WRITE" }),
    ],
    [
      "a repository that does not exist",
      DESCRIBE_CASES.archive.args,
      [{ match: "homepageUrl", stderr: "HTTP 404", code: 1 }],
    ],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...DESCRIBE_CASES.archive, args, rules })).toBeUndefined()
  })
})

describe("github_repo_unarchive", () => {
  const headline = named("About to unarchive the repository {name}")

  test("names the repository and shows the visibility it keeps", async () => {
    expect(await describeCase(DESCRIBE_CASES.unarchive)).toEqual({ headline, facts: [visibility("Public")] })
  })

  test("a repository that is not archived says nothing is sent", async () => {
    expect(await describeCase(DESCRIBE_CASES.unarchiveActive)).toEqual({
      headline,
      facts: [{ label: "State", value: { text: NOT_ARCHIVED } }],
    })
  })

  test("a repository the viewer does not administer gives no description", async () => {
    const rules = repoRules({ isArchived: true, viewerPermission: "WRITE" })
    expect(await describeCase({ ...DESCRIBE_CASES.unarchive, rules })).toBeUndefined()
  })
})

describe("github_repo_visibility", () => {
  test.each([
    ["publicToPrivate", "About to make the repository {name} private", "Public to private"],
    ["publicToInternal", "About to make the repository {name} internal", "Public to internal"],
    ["privateToPublic", "About to make the repository {name} public", "Private to public"],
    ["privateToInternal", "About to make the repository {name} internal", "Private to internal"],
    ["internalToPublic", "About to make the repository {name} public", "Internal to public"],
    ["internalToPrivate", "About to make the repository {name} private", "Internal to private"],
  ] as const)("%s: a headline by the visibility asked for and the transition", async (key, text, transition) => {
    expect(await describeCase(DESCRIBE_CASES[key])).toEqual({ headline: named(text), facts: [visibility(transition)] })
  })

  const change = DESCRIBE_CASES.privateToPublic
  test.each([
    ["the visibility it has already", { visibility: "public" }, repoRules()],
    [
      "internal for a user's repository",
      { visibility: "internal" },
      repoRules({ owner: { __typename: "User", login: "octo" }, visibility: "PRIVATE" }),
    ],
    [
      "a repository the viewer does not administer",
      change.args,
      repoRules({ visibility: "PRIVATE", viewerPermission: "MAINTAIN" }),
    ],
    ["an unknown visibility", { visibility: "secret" }, change.rules],
    ["no visibility", {}, change.rules],
  ])("%s: no description", async (_name, args, rules) => {
    expect(await describeCase({ ...change, args, rules })).toBeUndefined()
  })
})

describe("every description", () => {
  const cases = Object.values<DescribeCase>(DESCRIBE_CASES)

  test.each(cases.map((item) => [item.name, item] as const))("%s: is within the budgets", async (_name, item) => {
    const description = await describeCase(item)
    expect(description).toBeDefined()
    expect(Array.from(description!.headline!.text).length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH)
    expect(description!.facts.length).toBeLessThanOrEqual(MAX_FACTS)
    for (const { label } of description!.facts) expect(Array.from(label).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
  })

  test.each(cases.map((item) => [item.name, item] as const))(
    "%s: is the same when asked twice",
    async (_name, item) => {
      expect(await describeCase(item)).toEqual(await describeCase(item))
    },
  )

  test.each(cases.map((item) => [item.name, item] as const))("%s: only reads", async (_name, item) => {
    let calls: string[][] = []
    await describeCase(item, (seen) => (calls = seen))
    const isWrite = (args: string[]) =>
      queryOf(args).startsWith("mutation") || WRITE_METHODS.some((method) => args.includes(method))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(isWrite)).toEqual([])
  })
})
