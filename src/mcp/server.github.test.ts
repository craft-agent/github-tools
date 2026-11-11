import { afterEach, expect, test } from "bun:test"
import { annotations, toolMeta } from "../core"
import { PROJECT_PROFILE } from "../entry/profile"
import { ALL_TOOLS } from "../tools"
import { connect, runCleanups, settings } from "./testing"

afterEach(runCleanups)

test("the default toolsets list the real GitHub tools, and read_only leaves their writes out", async () => {
  const defaults = ALL_TOOLS.filter((spec) => PROJECT_PROFILE.toolsets.defaults.includes(spec.toolset))
  for (const read_only of [false, true]) {
    const { client } = await connect(ALL_TOOLS, settings({ read_only }), {}, { toolsets: PROJECT_PROFILE.toolsets })
    const { tools } = await client.listTools()
    const selected = defaults.filter((spec) => !read_only || spec.class === "read")
    expect(tools.map((tool) => tool.name)).toEqual(selected.map((spec) => spec.id))
    const issueRead = tools.find((tool) => tool.name === "github_issue_read")!
    expect(issueRead.inputSchema.required).toEqual(["method"])
    for (const spec of selected) {
      const listed = tools.find((tool) => tool.name === spec.id)!
      expect(listed.annotations).toEqual(annotations(spec))
      expect(listed._meta).toEqual(toolMeta(spec))
      expect(listed.inputSchema.additionalProperties).toBe(false)
      expect(listed.outputSchema?.type).toBe("object")
    }
  }
})
