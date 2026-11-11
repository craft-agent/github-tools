import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADMIN_ID, fixtureSpecs } from "./testing"
import type { V2Context, V2Skill } from "./types"
import { createV2Setup } from "./v2"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-"))
  await skill("free", "")
  await skill("issues-skill", "metadata:\n  toolset: issues\n")
  await skill("releases-skill", "metadata:\n  toolset: releases\n")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function skill(name: string, extra: string): Promise<void> {
  await mkdir(join(dir, name))
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\n${extra}---\nBody\n`)
}

async function registeredSkills(options?: Record<string, unknown>): Promise<string[]> {
  const skills: V2Skill[] = []
  const ctx: V2Context = {
    options,
    session: {
      async get() {
        return {}
      },
    },
    permission: { async assert() {} },
    tool: { transform: async (callback) => callback({ add: () => {} }) },
    skill: {
      transform: async (callback) => callback({ add: (added) => skills.push(added) }),
    },
  }
  await createV2Setup(fixtureSpecs([]), { env: {}, skillsDir: dir })(ctx)
  return skills.map(({ id }) => id)
}

describe("V2 skills follow the selected toolsets", () => {
  test("the default options register the issues-linked and the unlinked skills", async () => {
    expect(await registeredSkills()).toEqual(["free", "issues-skill"])
  })

  test('toolsets "all" registers every skill', async () => {
    expect(await registeredSkills({ toolsets: "all" })).toEqual(["free", "issues-skill", "releases-skill"])
  })

  test("an option that removes every tool of a toolset hides its skill", async () => {
    expect(await registeredSkills({ toolsets: "all", read_only: true })).toEqual(["free", "issues-skill"])
    expect(await registeredSkills({ toolsets: "all", exclude_tools: [ADMIN_ID] })).toEqual(["free", "issues-skill"])
    expect(await registeredSkills({ toolsets: ["releases"] })).toEqual(["free", "releases-skill"])
  })
})
