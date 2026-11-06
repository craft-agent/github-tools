import { z } from "zod"
import { isToolError } from "../errors"
import { GraphQLToolError } from "../gh"

/**
 * Organization issue field values: text, number, date, single-select option name,
 * or multi-select option names, keyed by the field's name.
 */
export const issueFieldValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]))

export type IssueFieldValues = z.output<typeof issueFieldValuesSchema>

/**
 * GraphQL fragment reading an issue's organization issue fields.
 * An organization has at most 25 fields, so `first:25` reads them all.
 */
export const ISSUE_FIELD_VALUES_FRAGMENT =
  "issueFieldValues(first:25){nodes{__typename ... on IssueFieldValueCommon{field{... on IssueFieldCommon{name}}} ... on IssueFieldTextValue{value} ... on IssueFieldNumberValue{value} ... on IssueFieldDateValue{value} ... on IssueFieldSingleSelectValue{name} ... on IssueFieldMultiSelectValue{options{name}}}}"

export type RawIssueFieldValue = {
  __typename?: string
  field?: { name?: string | null } | null
  value?: string | number | null
  name?: string | null
  options?: ({ name?: string | null } | null)[] | null
}

/**
 * Turns an issue's GraphQL `issueFieldValues` connection into a record of field name to value.
 * Value per type: text string, number number, date string, single select option name, multi select
 * array of option names. Unknown typenames and fields without a value are skipped; an empty
 * connection gives `{}`.
 */
export function issueFieldValues(
  connection: { nodes?: (RawIssueFieldValue | null)[] | null } | null | undefined,
): IssueFieldValues {
  const values: IssueFieldValues = {}
  for (const node of connection?.nodes ?? []) {
    if (!node) continue
    const fieldName = node.field?.name?.trim()
    if (!fieldName) continue

    switch (node.__typename) {
      case "IssueFieldTextValue":
        if (typeof node.value === "string") values[fieldName] = node.value
        break
      case "IssueFieldNumberValue":
        if (typeof node.value === "number" && !Number.isNaN(node.value)) values[fieldName] = node.value
        break
      case "IssueFieldDateValue":
        if (typeof node.value === "string") values[fieldName] = node.value
        break
      case "IssueFieldSingleSelectValue":
        if (typeof node.name === "string") values[fieldName] = node.name
        break
      case "IssueFieldMultiSelectValue": {
        const options = (node.options ?? [])
          .map((opt) => opt?.name)
          .filter((name): name is string => typeof name === "string")
        if (options.length > 0) values[fieldName] = options
        break
      }
    }
  }
  return values
}

const SCHEMA_ERROR_PATTERN = /issueFieldValues.*(?:doesn['’]t exist on type|is not defined on type).*['"`]?Issue['"`]?/i

/**
 * Whether a GraphQL error indicates that GitHub's schema lacks `issueFieldValues` on `Issue`
 * (such as GitHub Enterprise Server older than 3.23).
 */
export function isIssueFieldsMissingError(error: unknown): boolean {
  if (!isToolError(error)) return false
  if (error instanceof GraphQLToolError) {
    if (
      error.graphqlErrors.some((entry) => typeof entry.message === "string" && SCHEMA_ERROR_PATTERN.test(entry.message))
    ) {
      return true
    }
  }
  return SCHEMA_ERROR_PATTERN.test(error.message)
}
