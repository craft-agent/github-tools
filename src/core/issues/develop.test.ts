import { describe, expect, test } from "bun:test"
import {
  CREATE_LINKED_BRANCH,
  HEAD_SHA,
  ISSUE_ID,
  branchRule,
  createdBranchRule,
  defaultBranchRule,
  linkedBranchesRule,
} from "../../testing/develop-fixtures"
import type { FakeGh, GhRule } from "../../testing/fake-gh"
import { gqlErrors, gqlReply } from "../../testing/gql"
import { apiCalls, failure, variable } from "../../testing/issue-fixtures"
import { otherRepositoryRule } from "../../testing/relate-fixtures"
import { commands, repositoryRule, sent, writeRules, writes } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { issueDevelop } from "./develop"

const { use, run } = writeHarness(issueDevelop)

/** What a call needs when nothing is linked yet: the default branch `main`, which exists, and a branch made as `12-crash`. */
const creating = (...extra: GhRule[]): GhRule[] =>
  writeRules(
    ...extra,
    linkedBranchesRule(),
    defaultBranchRule("main"),
    branchRule("octo/hello", "main", true),
    createdBranchRule("12-crash"),
  )

/** The calls of the `createLinkedBranch` mutation. */
const mutations = (installed: FakeGh): string[][] =>
  apiCalls(installed).filter((args) => args.join(" ").includes(CREATE_LINKED_BRANCH))

const NOT_BRANCH_NAMES = [
  ["blank", " "],
  ["empty", ""],
  ["a NUL", "a\u0000b"],
  ["a control character", "a\u0001b"],
  ["DEL", "a\u007fb"],
  ["a tab", "a\tb"],
  ["a line break", "a\nb"],
  ["a space", "my branch"],
  ["a tilde", "a~1"],
  ["a caret", "a^"],
  ["a colon", "a:b"],
  ["a question mark", "a?"],
  ["a star", "a*"],
  ["a bracket", "a[0]"],
  ["a backslash", "a\\b"],
  ["two dots", "a..b"],
  ["@{", "a@{b"],
  ["the bare name @", "@"],
  ["a leading dash", "-x"],
  ["a leading slash", "/x"],
  ["a double slash", "a//b"],
  ["a trailing slash", "feature/"],
  ["a trailing dot", "release."],
  ["a leading dot", ".hidden"],
  ["a part that starts with a dot", "a/.hidden"],
  ["a trailing .lock", "main.lock"],
  ["a part that ends with .lock", "a.lock/b"],
] as const

describe.each(["branch", "base"] as const)("the %s name", (argument) => {
  test.each(NOT_BRANCH_NAMES)("%s is invalid_argument, before any call to GitHub", async (_name, value) => {
    const installed = use(creating())
    const error = await failure(run({ issue: "12", [argument]: value }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(argument)
    expect(sent(installed)).toEqual([])
  })

  test.each(["a.b", "@x", "a@b", "task/12-crash.fix", "release/1.x", "feature/x_y-z", "v1.0.0"])(
    "%s is a name git accepts",
    async (value) => {
      use(creating(branchRule("octo/hello", value.split("/").map(encodeURIComponent).join("/"), true)))
      expect((await run({ issue: "12", [argument]: value })).created).toBe(true)
    },
  )
})

describe("a branch that is linked already", () => {
  test("without branch, the first linked branch in the branch repository is returned as it is", async () => {
    const installed = use(
      writeRules(
        linkedBranchesRule([{ name: "elsewhere", repo: "other/thing" }, { name: "12-crash" }, { name: "second" }]),
      ),
    )
    expect(await run({ issue: "12", base: "release" })).toEqual({
      repo: "octo/hello",
      issue: 12,
      branch: "12-crash",
      branch_repo: "octo/hello",
      base: null,
      created: false,
      linked_branches: [
        { name: "elsewhere", repo: "other/thing" },
        { name: "12-crash", repo: "octo/hello" },
        { name: "second", repo: "octo/hello" },
      ],
      foreign: false,
    })
    expect(writes(installed)).toEqual([])
    expect(sent(installed).map((args) => args[0])).toEqual(["api", "api"])
  })

  test("with branch, the linked branch of that name is returned", async () => {
    const installed = use(writeRules(linkedBranchesRule([{ name: "first" }, { name: "second" }])))
    const result = await run({ issue: "12", branch: "second" })
    expect(result.branch).toBe("second")
    expect(result.created).toBe(false)
    expect(writes(installed)).toEqual([])
  })

  test("a linked branch of that name in another repository does not count", async () => {
    const installed = use(creating(linkedBranchesRule([{ name: "12-crash", repo: "other/thing" }])))
    const result = await run({ issue: "12", branch: "12-crash" })
    expect(result.created).toBe(true)
    expect(mutations(installed)).toHaveLength(1)
  })

  test("a linked branch in the issue's repository does not count for another branch repository", async () => {
    const installed = use(
      writeRules(
        otherRepositoryRule("other/thing"),
        linkedBranchesRule([{ name: "12-crash" }]),
        defaultBranchRule("trunk", "other"),
        branchRule("other/thing", "trunk", true),
        createdBranchRule("12-crash", "other/thing"),
      ),
    )
    const result = await run({ issue: "12", branch_repo: "other/thing" })
    expect(result).toMatchObject({ created: true, branch: "12-crash", branch_repo: "other/thing", base: "trunk" })
    expect(result.linked_branches).toEqual([
      { name: "12-crash", repo: "octo/hello" },
      { name: "12-crash", repo: "other/thing" },
    ])
    expect(mutations(installed)).toHaveLength(1)
  })
})

describe("the base", () => {
  test("a base that does not exist is not_found, and no branch is made", async () => {
    const installed = use(writeRules(linkedBranchesRule(), branchRule("octo/hello", "nope", false)))
    const error = await failure(run({ issue: "12", base: "nope" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Base branch nope does not exist in octo/hello.")
    expect(mutations(installed)).toEqual([])
  })

  test("a missing base with a slash in its name is not_found too", async () => {
    const installed = use(writeRules(linkedBranchesRule(), branchRule("octo/hello", "release/2.x", false)))
    const error = await failure(run({ issue: "12", base: "release/2.x" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Base branch release/2.x does not exist in octo/hello.")
    expect(mutations(installed)).toEqual([])
  })

  test.each([
    ["release/1.x", "release/1.x"],
    ["fix/#12", "fix/%2312"],
  ])("the head of base %s is read at the path %s, its slashes kept", async (base, path) => {
    const installed = use(creating(branchRule("octo/hello", path, true)))
    const result = await run({ issue: "12", base })
    expect(result.base).toBe(base)
    expect(sent(installed).map((args) => args.join(" "))).toContain(`api repos/octo/hello/branches/${path}`)
    expect(variable(mutations(installed)[0]!, "oid")).toBe(HEAD_SHA)
  })

  test("without a base, the default branch is read, and its head is where the branch starts", async () => {
    const installed = use(creating())
    const result = await run({ issue: "12" })
    expect(result.base).toBe("main")
    expect(sent(installed).map((args) => args.join(" "))).toContain("api repos/octo/hello/branches/main")
    expect(variable(mutations(installed)[0]!, "oid")).toBe(HEAD_SHA)
  })

  test("a repository without a default branch is not_found", async () => {
    const installed = use(writeRules(linkedBranchesRule(), defaultBranchRule(null)))
    expect((await failure(run({ issue: "12" }))).code).toBe("not_found")
    expect(mutations(installed)).toEqual([])
  })

  test("a failure to read the base other than not found is thrown as it is", async () => {
    use(writeRules(linkedBranchesRule(), { match: "^api repos/octo/hello/branches/", stderr: "HTTP 500", code: 1 }))
    expect((await failure(run({ issue: "12", base: "release" }))).code).toBe("github_error")
  })

  test("a base reply without a commit is a github_error", async () => {
    use(writeRules(linkedBranchesRule(), { match: "^api repos/octo/hello/branches/release$", stdout: "{}" }))
    expect((await failure(run({ issue: "12", base: "release" }))).code).toBe("github_error")
  })
})

describe("creating the branch", () => {
  test("goes through the API only: the mutation carries the issue, the commit and the repository", async () => {
    const installed = use(creating())
    await run({ issue: "12" })
    expect(mutations(installed)).toHaveLength(1)
    const [mutation] = mutations(installed)
    expect(variable(mutation!, "issueId")).toBe(ISSUE_ID)
    expect(variable(mutation!, "oid")).toBe(HEAD_SHA)
    expect(variable(mutation!, "repositoryId")).toBe("R_1")
    expect(variable(mutation!, "name")).toBeUndefined()
    expect(commands(installed)).toEqual([])
    expect(sent(installed).every((args) => args[0] === "api")).toBe(true)
  })

  test("a branch name goes with the mutation, and what GitHub made is reported", async () => {
    const installed = use(creating(createdBranchRule("task/12")))
    const result = await run({ issue: "12", branch: "task/12" })
    expect(variable(mutations(installed)[0]!, "name")).toBe("task/12")
    expect(result).toEqual({
      repo: "octo/hello",
      issue: 12,
      branch: "task/12",
      branch_repo: "octo/hello",
      base: "main",
      created: true,
      linked_branches: [{ name: "task/12", repo: "octo/hello" }],
      foreign: false,
    })
  })

  test("the name GitHub picks is reported, after the branches that were linked", async () => {
    use(creating(linkedBranchesRule([{ name: "elsewhere", repo: "other/thing" }])))
    const result = await run({ issue: "12" })
    expect(result.branch).toBe("12-crash")
    expect(result.linked_branches).toEqual([
      { name: "elsewhere", repo: "other/thing" },
      { name: "12-crash", repo: "octo/hello" },
    ])
  })

  test("a GraphQL error of the mutation keeps its code", async () => {
    use(
      creating({
        match: CREATE_LINKED_BRANCH,
        stdout: gqlErrors([{ type: "FORBIDDEN", message: "Resource not accessible by integration" }]),
      }),
    )
    expect((await failure(run({ issue: "12" }))).code).toBe("forbidden")
  })

  test("a reply without a branch is a github_error telling the person to look", async () => {
    use(creating({ match: CREATE_LINKED_BRANCH, stdout: gqlReply({ createLinkedBranch: null }) }))
    const error = await failure(run({ issue: "12" }))
    expect(error.code).toBe("github_error")
    expect(error.message).toContain("Development panel")
  })
})

describe("permission", () => {
  test("without write permission on the issue's repository nothing is read or made", async () => {
    const installed = use(creating(repositoryRule({ permission: "READ" })))
    expect((await failure(run({ issue: "12" }))).code).toBe("forbidden")
    expect(sent(installed)).toHaveLength(1)
  })

  test("without write permission on the branch repository nothing is made", async () => {
    const installed = use(creating(otherRepositoryRule("other/thing", { permission: "READ" })))
    const error = await failure(run({ issue: "12", branch_repo: "other/thing" }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("other/thing")
    expect(sent(installed).map((args) => args[0])).toEqual(["api", "api"])
  })

  test("the branch is made in the branch repository, whose id the mutation carries; foreign when it is not the viewer's", async () => {
    const installed = use(
      writeRules(
        otherRepositoryRule("other/thing", { viewer: "me", id: "R_other" }),
        linkedBranchesRule(),
        defaultBranchRule("main", "other"),
        branchRule("other/thing", "main", true),
        createdBranchRule("12-crash", "other/thing"),
      ),
    )
    const result = await run({ issue: "12", branch_repo: "other/thing" })
    expect(result).toMatchObject({ foreign: true, branch_repo: "other/thing", created: true })
    expect(variable(mutations(installed)[0]!, "repositoryId")).toBe("R_other")
  })

  test("a branch_repo that is the issue's repository is not checked twice", async () => {
    const installed = use(creating())
    await run({ issue: "12", branch_repo: "octo/hello" })
    expect(sent(installed).filter((args) => args.join(" ").includes("viewerPermission"))).toHaveLength(1)
    expect(variable(mutations(installed)[0]!, "repositoryId")).toBe("R_1")
  })

  test("a branch_repo that is not a repository is invalid_argument", async () => {
    const installed = use(creating())
    expect((await failure(run({ issue: "12", branch_repo: "nope" }))).code).toBe("invalid_argument")
    expect(sent(installed)).toEqual([])
  })
})
