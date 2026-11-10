import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  PIN_PATTERN,
  callDescription,
  pinOf,
  translator,
  type CallDescription,
  type ToolContext,
  type ToolSpec,
} from "../core"
import { MAX_FACTS, MAX_TEXT_LENGTH, MAX_VALUE_LENGTH } from "../core/describe"
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
  body?: string
  facts?: CallDescription["facts"]
}

function fixture(state: State, targets: ToolSpec["targets"] = { repo: "repo" }) {
  const describeNow = (): CallDescription | Promise<CallDescription> => {
    if (state.describe === "throw") throw new Error("gone")
    if (state.describe === "hang") return new Promise<CallDescription>(() => {})
    if (state.describe === "bad") return { facts: "nope" } as unknown as CallDescription
    return {
      headline: { text: "Write {name}", values: { name: "todo" } },
      facts: state.facts ?? [{ label: "Size", value: { text: "{bytes} bytes", values: { bytes: state.size } } }],
      ...(state.body !== undefined && { text: { label: "Note text", body: state.body } }),
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

  describe("content past the prompt's budgets", () => {
    const STALE = { name: "ToolError", code: "stale" }
    const factsOf = (count: number, tail = "") =>
      Array.from({ length: count }, (_, index) => ({ label: `Fact ${index + 1}`, value: `value ${index + 1}${tail}` }))

    /** The state's approval, then the state changed by `change`, then the check against it. */
    async function checkLong(start: Partial<State>, change: (state: State) => void) {
      const state = { ...fresh(), ...start }
      const { pin } = await approvalOf(fixture(state), {}, CTX, 50)
      change(state)
      return checkPin(fixture(state), {}, CTX, pin, 50).catch((caught: unknown) => caught)
    }

    test("throws stale when the body changes past the text budget, and the prompt shows only the budget", async () => {
      const body = "a".repeat(MAX_TEXT_LENGTH + 500)
      const changeAt = MAX_TEXT_LENGTH + 400
      const approval = await approvalOf(fixture({ ...fresh(), body }), {}, CTX)
      const shown = approval.description?.text?.body ?? ""
      expect(Array.from(shown)).toHaveLength(MAX_TEXT_LENGTH)
      expect(shown.endsWith("…")).toBe(true)
      const error = await checkLong(
        { body },
        (state) => (state.body = `${body.slice(0, changeAt)}b${body.slice(changeAt + 1)}`),
      )
      expect(error).toMatchObject(STALE)
    })

    test("throws stale when a fact value changes past the value budget", async () => {
      const facts = (tail: string) => [{ label: "Big", value: `${"v".repeat(MAX_VALUE_LENGTH + 99)}${tail}` }]
      const error = await checkLong({ facts: facts("x") }, (state) => (state.facts = facts("y")))
      expect(error).toMatchObject(STALE)
    })

    test("throws stale when the fact past the fact budget changes, and the prompt shows only the budget", async () => {
      const approval = await approvalOf(fixture({ ...fresh(), facts: factsOf(MAX_FACTS + 1) }), {}, CTX)
      expect(approval.description?.facts).toHaveLength(MAX_FACTS)
      const error = await checkLong({ facts: factsOf(MAX_FACTS + 1) }, (state) => {
        state.facts = [...factsOf(MAX_FACTS), { label: `Fact ${MAX_FACTS + 1}`, value: "other" }]
      })
      expect(error).toMatchObject(STALE)
    })

    test("passes when a long description did not change", async () => {
      const error = await checkLong(
        { body: "a".repeat(MAX_TEXT_LENGTH + 500), facts: factsOf(MAX_FACTS + 1, "x".repeat(MAX_VALUE_LENGTH + 100)) },
        () => {},
      )
      expect(error).toBeUndefined()
    })

    test("keeps the pin of the cut description when nothing was cut", async () => {
      const state = fresh()
      const approval = await approvalOf(fixture(state), {}, CTX)
      const cutOne = await callDescription(fixture(state), {}, CTX)
      expect(cutOne).toBeDefined()
      expect(approval.pin).toBe(pinOf(approval.resources, cutOne as CallDescription))
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
