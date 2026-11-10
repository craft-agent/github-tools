import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { PIN_PATTERN, translator, type CallDescription, type ToolContext, type ToolSpec } from "../core"
import { shownDescription } from "./description"
import { approvalOf, checkPin } from "./pin"

const CTX: ToolContext = { cwd: "/work" }
const ID = "github_issue_comment"
const input = z.object({ name: z.string().default("todo"), repo: z.string().optional() })

/** What a fixture's describer and the call's repository answer now; a test changes it between the approval and the check. */
type State = {
  size: number
  hash: string
  repo: string
  describe: "answer" | "throw" | "hang" | "bad" | "none"
}

function fixture(state: State, targets: ToolSpec["targets"] = { repo: "repo" }) {
  const describeNow = (): CallDescription | Promise<CallDescription> => {
    if (state.describe === "throw") throw new Error("gone")
    if (state.describe === "hang") return new Promise<CallDescription>(() => {})
    if (state.describe === "bad") return { facts: "nope" } as unknown as CallDescription
    return {
      headline: { text: "Write {name}", values: { name: "todo" } },
      facts: [{ label: "Size", value: { text: "{bytes} bytes", values: { bytes: state.size } } }],
      pins: { hash: state.hash },
    }
  }
  return {
    id: ID,
    input,
    targets,
    describe: state.describe === "none" ? undefined : describeNow,
  } as Pick<ToolSpec, "id" | "input" | "targets" | "describe">
}

const fresh = (): State => ({ size: 42, hash: "abc", repo: "Octo/Todo", describe: "answer" })

/** The arguments of the call as the state has it: the repository it writes to. */
const argsOf = (state: State) => ({ repo: state.repo })

/** The pin of a call as it stands, then the state changed by `change`, then the check against that pin. */
async function checkAfter(change: (state: State) => void, timeoutMs = 50) {
  const state = fresh()
  const { pin } = await approvalOf(fixture(state), argsOf(state), CTX, timeoutMs)
  change(state)
  return checkPin(fixture(state), argsOf(state), CTX, pin, timeoutMs)
}

describe("approvalOf", () => {
  test("gives the resources, the shown description and a pin", async () => {
    const state = fresh()
    const approval = await approvalOf(fixture(state), argsOf(state), CTX)
    expect(approval.resources).toEqual(["octo/todo"])
    expect(approval.description).toEqual({ headline: 'Write "todo"', facts: [{ label: "Size", value: "42 bytes" }] })
    expect(approval.pin).toMatch(PIN_PATTERN)
  })

  test("never shows the pins", async () => {
    const raw: CallDescription = { facts: [{ label: "A", value: "b" }], pins: { hash: "abc" } }
    expect(shownDescription(raw, translator({}, undefined))).toEqual({ facts: [{ label: "A", value: "b" }] })
    const state = fresh()
    const approval = await approvalOf(fixture(state), argsOf(state), CTX)
    expect(JSON.stringify(approval.description)).not.toContain("abc")
  })

  test("gives no pin and no description for a tool without a describer, but the resources", async () => {
    const state: State = { ...fresh(), describe: "none" }
    const approval = await approvalOf(fixture(state), argsOf(state), CTX)
    expect(approval).toEqual({ resources: ["octo/todo"] })
  })

  test.each<State["describe"]>(["throw", "bad", "hang"])("gives no pin when describing %s", async (mode) => {
    const state: State = { ...fresh(), describe: mode }
    const approval = await approvalOf(fixture(state), argsOf(state), CTX, 20)
    expect(approval).toEqual({ resources: ["octo/todo"] })
  })

  test("gives the same pin whatever the prompt language", async () => {
    const japanese = translator(
      { ja: { "Write {name}": "{name} を書く", Size: "サイズ", "{bytes} bytes": "{bytes} バイト" } },
      "ja",
    )
    const state = fresh()
    const english = await approvalOf(fixture(state), argsOf(state), CTX)
    const translated = await approvalOf(fixture(state), argsOf(state), CTX, 50, japanese)
    expect(translated.description?.headline).toBe('"todo" を書く')
    expect(translated.pin).toBe(english.pin)
  })

  test("gives another pin for another state", async () => {
    const state = fresh()
    const before = await approvalOf(fixture(state), argsOf(state), CTX)
    const changed: State = { ...fresh(), hash: "abd" }
    const after = await approvalOf(fixture(changed), argsOf(changed), CTX)
    expect(after.pin).not.toBe(before.pin)
  })
})

describe("checkPin", () => {
  test("passes when nothing changed", async () => {
    await expect(checkAfter(() => {})).resolves.toBeUndefined()
  })

  test.each<[string, (state: State) => void]>([
    ["a fact", (state) => (state.size = 43)],
    ["a hidden pin", (state) => (state.hash = "abd")],
    ["a resource", (state) => (state.repo = "Octo/Other")],
    ["a describer that now throws", (state) => (state.describe = "throw")],
    ["a describer that now answers a bad shape", (state) => (state.describe = "bad")],
    ["a describer that now takes too long", (state) => (state.describe = "hang")],
    ["a tool that no longer describes", (state) => (state.describe = "none")],
  ])("throws stale for %s", async (_name, change) => {
    const error = await checkAfter(change, 20).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      name: "ToolError",
      code: "stale",
      message: `${ID} did not run: what its approval showed changed before it could run. Call it again to be asked again.`,
    })
  })

  test("without a pin returns at once and resolves nothing", async () => {
    let called = false
    const targets = new Proxy({ repo: "repo" } as const, {
      ownKeys(target) {
        called = true
        return Reflect.ownKeys(target)
      },
    })
    const state = fresh()
    const spec = {
      ...fixture(state, targets),
      describe: () => {
        called = true
        return { facts: [] }
      },
    }
    await expect(checkPin(spec, argsOf(state), CTX, undefined)).resolves.toBeUndefined()
    expect(called).toBe(false)
  })

  test("rethrows the cancellation instead of turning it into stale", async () => {
    const state = fresh()
    const { pin } = await approvalOf(fixture(state), argsOf(state), CTX)
    const controller = new AbortController()
    const reason = new Error("stop")
    state.describe = "hang"
    const pending = checkPin(fixture(state), argsOf(state), { ...CTX, signal: controller.signal }, pin)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})
