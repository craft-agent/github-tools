import type { CallDescription, ToolSpec } from "../core"

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

/** The words a description writes in English: the headline template, the text label, every fact label and every fact value template (a plain string value is data). */
export function describedWords(description: CallDescription | undefined): string[] {
  if (!description) return []
  const words: string[] = []
  if (description.headline) words.push(description.headline.text)
  if (description.text) words.push(description.text.label)
  for (const { label, value } of description.facts) {
    words.push(label)
    if (typeof value !== "string") words.push(value.text)
  }
  return words
}
