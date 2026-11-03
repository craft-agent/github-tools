/** The prefix of the label that carries an issue's kind where no Issue Type can. */
export const KIND_LABEL_PREFIX = "type:"

/**
 * An issue's kind, lower-cased: its Issue Type's name, else the suffix of its
 * `type:<kind>` label, else `null`.
 */
export function readKind(issueTypeName: string | null | undefined, labels: readonly string[]): string | null {
  if (issueTypeName) return issueTypeName.toLowerCase()
  for (const label of labels) {
    const kind = label.toLowerCase().startsWith(KIND_LABEL_PREFIX) ? label.slice(KIND_LABEL_PREFIX.length).trim() : ""
    if (kind) return kind.toLowerCase()
  }
  return null
}

/** The label that carries `kind`: `type:` and the kind in lower case. */
export function kindLabel(kind: string): string {
  return `${KIND_LABEL_PREFIX}${kind.toLowerCase()}`
}
