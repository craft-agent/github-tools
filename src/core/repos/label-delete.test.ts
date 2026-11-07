import { expect, test } from "bun:test"
import { failure } from "../../testing/issue-fixtures"
import { LABEL_ROW, labelPages, writeLog } from "../../testing/repos-fixtures"
import { repositoryRule } from "../../testing/write-fixtures"
import { writeHarness } from "../../testing/write-harness"
import { invoke, type ConfirmRequest } from "../tool"
import { labelDelete } from "./label-delete"

const { use, run } = writeHarness(labelDelete)
const deleted = { match: "-X DELETE" }

test("DELETE matches any case and encodes the current label name", async () => {
  const installed = use([repositoryRule(), labelPages([{ ...LABEL_ROW, name: "Bug / #1?" }]), deleted])
  expect(await run({ name: "bug / #1?" })).toEqual({ repo: "octo/hello", deleted: "Bug / #1?", foreign: false })
  expect(writeLog(installed)).toEqual([
    { args: ["api", "-X", "DELETE", "repos/octo/hello/labels/Bug%20%2F%20%231%3F"], body: null },
  ])
})

test.each([true, false])("confirmation accepted=%p", async (accept) => {
  const installed = use([repositoryRule(), labelPages([LABEL_ROW]), deleted])
  const requests: ConfirmRequest[] = []
  const result = invoke(
    labelDelete,
    { repo: "octo/hello", name: "BUG" },
    {
      cwd: process.cwd(),
      confirm: async (request) => {
        requests.push(request)
        return accept
      },
    },
  )
  if (accept) expect((await result).deleted).toBe("Bug")
  else expect((await failure(result)).code).toBe("declined")
  expect(requests).toEqual([
    {
      tool: "github_label_delete",
      message: 'Delete the label "Bug" from octo/hello? It leaves every issue and pull request it is on.',
    },
  ])
  expect(writeLog(installed).length).toBe(accept ? 1 : 0)
})

test("unknown labels name nothing else and are not written", async () => {
  const installed = use([repositoryRule(), labelPages([LABEL_ROW]), deleted])
  const error = await failure(run({ name: "missing" }))
  expect(error.code).toBe("not_found")
  expect(error.message).toBe('Label "missing" was not found.')
  expect(writeLog(installed)).toEqual([])
})

test("write permission is required", async () => {
  const installed = use([repositoryRule({ permission: "READ" })])
  expect((await failure(run({ name: "Bug" }))).code).toBe("forbidden")
  expect(writeLog(installed)).toEqual([])
})

test("a blank name writes nothing", async () => {
  const installed = use([])
  expect((await failure(run({ name: " " }))).code).toBe("invalid_argument")
  expect(writeLog(installed)).toEqual([])
})

test("explicit foreign repository", async () => {
  const installed = use([repositoryRule({ repo: "other/thing", viewer: "me" }), labelPages([LABEL_ROW]), deleted])
  expect(await run({ repo: "other/thing", name: "Bug" })).toEqual({
    repo: "other/thing",
    deleted: "Bug",
    foreign: true,
  })
  expect(writeLog(installed)[0]!.args).toContain("repos/other/thing/labels/Bug")
})
