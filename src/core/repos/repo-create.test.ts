import { describe, expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { repositoryFactsRule, repositoryOwnerRule, writeLog } from "../../testing/repos-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { repoCreate } from "./repo-create"

const { use, run } = writeHarness(repoCreate)

const created = (visibility = "private", full = "octo/new") =>
  ({
    match: "-X POST",
    stdout: JSON.stringify({ full_name: full, html_url: `https://github.com/${full}`, visibility }),
  }) as const

/** `octo` is an organization the viewer `alice` can create in; `octo/new` does not exist, `octo/hello-template` is a template. */
const rules = (...extra: Parameters<typeof use>[0]) => [
  ...extra,
  repositoryOwnerRule("octo", { type: "Organization" }),
  repositoryFactsRule("octo/new", null),
  repositoryFactsRule("octo/hello-template", { isTemplate: true }),
  repositoryFactsRule("octo/plain", { isTemplate: false }),
  created(),
]

describe("the endpoints", () => {
  test("an organization's repository is private by default", async () => {
    const installed = use(rules())
    expect(await run({ repo: "octo/new" })).toEqual({
      repo: "octo/new",
      url: "https://github.com/octo/new",
      visibility: "private",
      created: true,
    })
    expect(writeLog(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "orgs/octo/repos", "--input", "-"],
        body: { name: "new", private: true, visibility: "private" },
      },
    ])
  })

  test("the viewer's own repository goes to user/repos, without a visibility field", async () => {
    const installed = use([
      repositoryOwnerRule("alice", { viewer: "Alice", type: "User" }),
      repositoryFactsRule("alice/new", null),
      created("public", "alice/new"),
    ])
    expect(
      await run({
        repo: "alice/new",
        visibility: "public",
        description: " A tool ",
        homepage: "https://tool.example",
        license: "mit",
        gitignore: "Node",
        add_readme: true,
      }),
    ).toEqual({ repo: "alice/new", url: "https://github.com/alice/new", visibility: "public", created: true })
    expect(writeLog(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "user/repos", "--input", "-"],
        body: {
          name: "new",
          description: "A tool",
          homepage: "https://tool.example",
          private: false,
          auto_init: true,
          license_template: "mit",
          gitignore_template: "Node",
        },
      },
    ])
  })

  test("internal is sent as private with the visibility for an organization", async () => {
    const installed = use(rules(created("internal")))
    expect((await run({ repo: "octo/new", visibility: "internal" })).visibility).toBe("internal")
    expect(writeLog(installed)[0]!.body).toEqual({ name: "new", private: true, visibility: "internal" })
  })

  test("a public organization repository is not private", async () => {
    const installed = use(rules(created("public")))
    await run({ repo: "octo/new", visibility: "public" })
    expect(writeLog(installed)[0]!.body).toEqual({ name: "new", private: false, visibility: "public" })
  })

  test("a reply without a visibility reports the one asked for", async () => {
    use(
      rules({
        match: "-X POST",
        stdout: JSON.stringify({ full_name: "octo/new", html_url: "https://github.com/octo/new" }),
      }),
    )
    expect((await run({ repo: "octo/new", visibility: "public" })).visibility).toBe("public")
  })

  test("a reply without the repository is a github_error", async () => {
    use(rules({ match: "-X POST", stdout: "{}" }))
    expect((await failure(run({ repo: "octo/new" }))).code).toBe("github_error")
  })
})

describe("from a template", () => {
  test("generates the repository from the template, without its other branches", async () => {
    const installed = use(rules())
    expect(await run({ repo: "octo/new", template: "octo/hello-template", description: "From it" })).toMatchObject({
      repo: "octo/new",
      visibility: "private",
      created: true,
    })
    expect(writeLog(installed)).toEqual([
      {
        args: ["api", "-X", "POST", "repos/octo/hello-template/generate", "--input", "-"],
        body: { owner: "octo", name: "new", description: "From it", private: true, include_all_branches: false },
      },
    ])
  })

  test("a public one is not private", async () => {
    const installed = use(rules(created("public")))
    await run({ repo: "octo/new", template: "octo/hello-template", visibility: "public" })
    expect(writeLog(installed)[0]!.body).toMatchObject({ private: false })
  })

  test.each([
    [
      { license: "mit" },
      "A repository created from a template takes its files from it; leave out license, gitignore and add_readme.",
    ],
    [
      { gitignore: "Node" },
      "A repository created from a template takes its files from it; leave out license, gitignore and add_readme.",
    ],
    [
      { add_readme: true },
      "A repository created from a template takes its files from it; leave out license, gitignore and add_readme.",
    ],
    [
      { homepage: "https://x.example" },
      "A repository created from a template cannot be given a homepage; set it with github_repo_edit afterwards.",
    ],
    [
      { visibility: "internal" },
      "A repository created from a template is public or private; create it private, then change it with github_repo_visibility.",
    ],
  ])("%p is refused with a template, before anything is read", async (extra, message) => {
    const installed = use(rules())
    const error = await failure(run({ repo: "octo/new", template: "octo/hello-template", ...extra }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(message)
    expect(installed.calls().filter((args) => args[0] === "api")).toEqual([])
  })

  test("a template that does not exist", async () => {
    const installed = use(rules(repositoryFactsRule("octo/gone", null)))
    const error = await failure(run({ repo: "octo/new", template: "octo/gone" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("Template octo/gone was not found, or the viewer cannot see it.")
    expect(writeLog(installed)).toEqual([])
  })

  test("a repository that is no template", async () => {
    const installed = use(rules())
    const error = await failure(run({ repo: "octo/new", template: "octo/plain" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("octo/plain is not a template repository.")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("confirmation", () => {
  const confirming = (accept: boolean, requests: ConfirmRequest[]) => ({
    cwd: process.cwd(),
    confirm: async (request: ConfirmRequest) => {
      requests.push(request)
      return accept
    },
  })

  test.each([
    [{}, "Create the private repository octo/new?"],
    [{ visibility: "public" }, "Create the public repository octo/new? A public repository is readable by anyone."],
    [{ visibility: "internal" }, "Create the internal repository octo/new?"],
    [
      { template: "octo/hello-template" },
      "Create the private repository octo/new from the template octo/hello-template?",
    ],
  ])("%p asks %p", async (extra, message) => {
    use(rules())
    const requests: ConfirmRequest[] = []
    await invoke(repoCreate, { repo: "octo/new", ...extra }, confirming(true, requests))
    expect(requests).toEqual([{ tool: "github_repo_create", message }])
  })

  test("a declined confirmation writes nothing", async () => {
    const installed = use(rules())
    const error = await failure(invoke(repoCreate, { repo: "octo/new" }, confirming(false, [])))
    expect(error.code).toBe("declined")
    expect(writeLog(installed)).toEqual([])
  })
})

describe("refusals", () => {
  test("a repository that exists already", async () => {
    const installed = use(rules(repositoryFactsRule("octo/new", { isTemplate: false })))
    const error = await failure(run({ repo: "octo/new" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("Repository octo/new exists already.")
    expect(writeLog(installed)).toEqual([])
  })

  test("internal for a user", async () => {
    const installed = use([repositoryOwnerRule("alice", { type: "User" }), repositoryFactsRule("alice/new", null)])
    const error = await failure(run({ repo: "alice/new", visibility: "internal" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("internal is for an organization's repository; pick public or private.")
    expect(writeLog(installed)).toEqual([])
  })

  test("another user's account", async () => {
    const installed = use([repositoryOwnerRule("bob", { type: "User" }), repositoryFactsRule("bob/new", null)])
    const error = await failure(run({ repo: "bob/new" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      "bob is another user's account; create the repository as yourself or in an organization.",
    )
    expect(writeLog(installed)).toEqual([])
  })

  test("an owner that does not exist is not_found", async () => {
    const installed = use([repositoryOwnerRule("ghost", { type: null })])
    const error = await failure(run({ repo: "ghost/new" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Owner ghost was not found, or the viewer cannot see it.")
    expect(writeLog(installed)).toEqual([])
  })

  test.each([["new"], ["octo/new/extra"], [""]])("%p is no repository", async (repo) => {
    const installed = use(rules())
    expect((await failure(run({ repo }))).code).toBe("invalid_argument")
    expect(writeLog(installed)).toEqual([])
  })

  test("the repository is required", async () => {
    use(rules())
    expect((await failure(run({}))).code).toBe("invalid_argument")
  })
})
