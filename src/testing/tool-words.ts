import type { ToolSpec } from "../core"

/** The sorted, de-duplicated titles and intents of the write tools among the specs: the words their approval prompts translate. */
export function toolWords(specs: ToolSpec[]): string[] {
  const words = new Set<string>()
  for (const spec of specs) {
    if (spec.class === "read") continue
    words.add(spec.title)
    if (spec.intent !== undefined) words.add(spec.intent)
  }
  return [...words].sort()
}
