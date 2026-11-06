import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { GraphQLToolError, graphql, lit } from "../gh"
import type { RefContext, RepoName } from "../refs"
import { dateOf, listOf, numberOf, textOf, type FieldValue } from "./board-field-values"
import { sameTitle } from "./projects"

/**
 * Organization issue field values: text, number, date, single-select option name,
 * or multi-select option names, keyed by the field's name.
 */
export const issueFieldValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]))

export type IssueFieldValues = z.output<typeof issueFieldValuesSchema>

/**
 * Selection of an issue field's value across its possible types.
 */
export const ISSUE_FIELD_VALUE_SELECTION =
  "__typename ... on IssueFieldTextValue{value} ... on IssueFieldNumberValue{value} ... on IssueFieldDateValue{value} ... on IssueFieldSingleSelectValue{name} ... on IssueFieldMultiSelectValue{options{name}}"

/**
 * GraphQL fragment reading an issue's organization issue fields.
 * An organization has at most 25 fields, so `first:25` reads them all.
 */
export const ISSUE_FIELD_VALUES_FRAGMENT = `issueFieldValues(first:25){nodes{... on IssueFieldValueCommon{field{... on IssueFieldCommon{name}}} ${ISSUE_FIELD_VALUE_SELECTION}}}`

export type RawIssueFieldValue = {
  __typename?: string
  field?: { name?: string | null } | null
  value?: string | number | null
  name?: string | null
  options?: ({ name?: string | null } | null)[] | null
}

type IssueFieldValueConnection = { nodes?: (RawIssueFieldValue | null)[] | null } | null | undefined

/**
 * Turns one issue field value node from GraphQL into its plain value: text string, number, date
 * string, single select option name, or multi select array of option names.
 * Returns `undefined` when the node has no value, an unknown typename, or an empty multi-select.
 */
export function issueFieldValueOf(node: RawIssueFieldValue | null | undefined): string | number | string[] | undefined {
  if (!node) return undefined

  switch (node.__typename) {
    case "IssueFieldTextValue":
      return typeof node.value === "string" ? node.value : undefined
    case "IssueFieldNumberValue":
      return typeof node.value === "number" && !Number.isNaN(node.value) ? node.value : undefined
    case "IssueFieldDateValue":
      return typeof node.value === "string" ? node.value : undefined
    case "IssueFieldSingleSelectValue":
      return typeof node.name === "string" ? node.name : undefined
    case "IssueFieldMultiSelectValue": {
      const options = (node.options ?? [])
        .map((opt) => opt?.name)
        .filter((name): name is string => typeof name === "string")
      return options.length > 0 ? options : undefined
    }
    default:
      return undefined
  }
}

/**
 * Turns an issue's GraphQL `issueFieldValues` connection into a record of field name to value.
 * Value per type: text string, number number, date string, single select option name, multi select
 * array of option names. Unknown typenames and fields without a value are skipped; an empty
 * connection gives `{}`.
 */
export function issueFieldValues(connection: IssueFieldValueConnection): IssueFieldValues {
  const values: IssueFieldValues = {}
  for (const node of connection?.nodes ?? []) {
    if (!node) continue
    const fieldName = node.field?.name?.trim()
    if (!fieldName) continue

    const val = issueFieldValueOf(node)
    if (val !== undefined) values[fieldName] = val
  }
  return values
}

const SCHEMA_ERROR_PATTERNS = [
  /issueFieldValues.*(?:doesn['’]t exist on type|is not defined on type).*['"`]?Issue['"`]?/i,
  /issueFields.*(?:doesn['’]t exist on type|is not defined on type).*['"`]?(?:Repository|Organization)['"`]?/i,
  /(?:isIssueField|issueField).*(?:doesn['’]t exist on type|is not defined on type).*['"`]?ProjectV2/i,
  /(?:No such type\s+['"`]?(?:ProjectV2ItemIssueFieldValue|ProjectV2IssueFieldValues)['"`]?|(?:ProjectV2ItemIssueFieldValue|ProjectV2IssueFieldValues).*(?:doesn['’]t exist|is not defined))/i,
]

function matchesSchemaError(text: string): boolean {
  return SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Whether a GraphQL error indicates that GitHub's schema lacks issue fields: `issueFieldValues` on
 * `Issue`, `issueFields` on `Repository` or `Organization`, `isIssueField` on `ProjectV2Field`, or `ProjectV2ItemIssueFieldValue` /
 * `ProjectV2IssueFieldValues` on board items (such as GitHub Enterprise Server older than 3.23).
 */
export function isIssueFieldsMissingError(error: unknown): boolean {
  if (!isToolError(error)) return false
  if (error instanceof GraphQLToolError) {
    if (error.graphqlErrors.some((entry) => typeof entry.message === "string" && matchesSchemaError(entry.message))) {
      return true
    }
  }
  return matchesSchemaError(error.message)
}

/** The organization issue fields to set, by field name; the same shape as the values a read reports. */
export const issueFieldInputSchema = issueFieldValuesSchema

/** The description of a tool's argument that sets issue fields. */
export const ISSUE_FIELDS_ARGUMENT =
  'The organization\'s issue fields to set, by field name (without regard to case): {"Priority": "High", "Target date": "2026-12-01"}. Each takes a text, a number, a date as YYYY-MM-DD, an option name, or a list of option names for a multi-select field.'

/** The most issue fields an organization defines, which one read covers. */
const MAX_ISSUE_FIELDS = 25

/** What a definitions read selects of each issue field: `IssueFieldCommon` has no `id`, so it is selected per type. */
const DEFINITION_SELECTION =
  "__typename ... on IssueFieldCommon{name dataType} ... on IssueFieldText{id} ... on IssueFieldNumber{id} ... on IssueFieldDate{id} ... on IssueFieldSingleSelect{id options{id name}} ... on IssueFieldMultiSelect{id options{id name}}"

const DEFINITIONS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issueFields(first:${MAX_ISSUE_FIELDS}){nodes{${DEFINITION_SELECTION}}}}}`

const ORGANIZATION_DEFINITIONS_QUERY = `query($login:String!){repositoryOwner(login:$login){__typename ... on Organization{issueFields(first:${MAX_ISSUE_FIELDS}){nodes{${DEFINITION_SELECTION}}}}}}`

const VALUES_QUERY = `query($id:ID!){node(id:$id){... on Issue{${ISSUE_FIELD_VALUES_FRAGMENT}}}}`

const issueFieldTypes = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SINGLE_SELECT: "single_select",
  MULTI_SELECT: "multi_select",
} as const

/** What a field holds: GitHub's `dataType`, as the lower-case word the tools use. */
export type IssueFieldType = (typeof issueFieldTypes)[keyof typeof issueFieldTypes]

/** What each type of field takes, for the messages that refuse a value. */
const TAKES: Record<IssueFieldType, string> = {
  text: "text",
  number: "a number",
  date: "a date as YYYY-MM-DD",
  single_select: "one option name",
  multi_select: "a list of option names",
}

/** An organization issue field of a repository, with the options of a select field. */
export type IssueFieldDefinition = {
  id: string
  name: string
  type: IssueFieldType
  options: { id: string; name: string }[]
}

/**
 * One entry of the `issueFields` input of `setIssueFieldValue`: the field and
 * one of the values it takes by type, or `delete` to clear it.
 */
export type IssueFieldWrite = {
  fieldId: string
  textValue?: string
  numberValue?: number
  dateValue?: string
  singleSelectOptionId?: string
  multiSelectOptionIds?: string[]
  delete?: true
}

type RawIssueFieldDefinition = {
  id?: string
  name?: string
  dataType?: string
  options?: ({ id?: string; name?: string } | null)[] | null
}

function isIssueFieldType(dataType: string | undefined): dataType is keyof typeof issueFieldTypes {
  return dataType !== undefined && Object.hasOwn(issueFieldTypes, dataType)
}

function definitionOf(raw: RawIssueFieldDefinition | null): IssueFieldDefinition | undefined {
  if (!raw?.id || !raw.name || !isIssueFieldType(raw.dataType)) return undefined
  const options = (raw.options ?? []).flatMap((option) =>
    option?.id && option.name ? [{ id: option.id, name: option.name }] : [],
  )
  return { id: raw.id, name: raw.name, type: issueFieldTypes[raw.dataType], options }
}

/**
 * The issue fields the organization of `repo` defines, which can be set on its issues. A repository
 * that has none (a personal account's, or an organization's without any) and a GitHub without issue
 * fields give `[]`; fields of a type this code does not know are left out. Other failures are thrown.
 */
export async function readIssueFieldDefinitions(repo: RepoName, ctx: RefContext): Promise<IssueFieldDefinition[]> {
  let data: {
    repository?: { issueFields?: { nodes?: (RawIssueFieldDefinition | null)[] | null } | null } | null
  } | null
  try {
    data = await graphql(DEFINITIONS_QUERY, { owner: repo.owner, name: repo.name }, ctx)
  } catch (error) {
    if (isIssueFieldsMissingError(error)) return []
    throw error
  }
  return (data?.repository?.issueFields?.nodes ?? []).flatMap((raw) => definitionOf(raw) ?? [])
}

/**
 * The issue fields the organization `login` defines, whatever repository they are set on; fields of a
 * type this code does not know are left out. `null` when the owner is not an organization (a user has
 * none) and when GitHub has no issue fields, so a caller can tell that from an organization that
 * defines none (`[]`). Other failures are thrown.
 */
export async function readOrganizationIssueFields(
  login: string,
  ctx: RefContext,
): Promise<IssueFieldDefinition[] | null> {
  let data: {
    repositoryOwner?: {
      __typename?: string
      issueFields?: { nodes?: (RawIssueFieldDefinition | null)[] | null } | null
    } | null
  } | null
  try {
    data = await graphql(ORGANIZATION_DEFINITIONS_QUERY, { login }, ctx)
  } catch (error) {
    if (isIssueFieldsMissingError(error)) return null
    throw error
  }
  if (data?.repositoryOwner?.__typename !== "Organization") return null
  return (data.repositoryOwner.issueFields?.nodes ?? []).flatMap((raw) => definitionOf(raw) ?? [])
}

/** The issue field of this name (without regard to case or surrounding space), if the definitions have one. */
export function findIssueField(
  definitions: readonly IssueFieldDefinition[],
  name: string,
): IssueFieldDefinition | undefined {
  return definitions.find((candidate) => sameTitle(candidate.name, name))
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

function fieldNames(definitions: readonly IssueFieldDefinition[]): string {
  return listOf(definitions.map((field) => field.name))
}

function fieldOf(repo: RepoName, definitions: readonly IssueFieldDefinition[], name: string): IssueFieldDefinition {
  const field = findIssueField(definitions, name)
  if (!field) throw invalid(`${repo.full} has no issue field "${name}". Fields: ${fieldNames(definitions)}.`)
  return field
}

function optionOf(field: IssueFieldDefinition, value: FieldValue): { id: string; name: string } {
  const name = textOf(field.name, value, "an option name")
  const option = field.options.find((candidate) => sameTitle(candidate.name, name))
  if (!option) {
    throw invalid(
      `"${field.name}" has no option "${name}". Options: ${listOf(field.options.map((each) => each.name))}.`,
    )
  }
  return option
}

function multiOptionIdsOf(field: IssueFieldDefinition, value: IssueFieldValues[string]): string[] {
  const names = Array.isArray(value) ? value : [value]
  if (names.length === 0) {
    throw invalid(`"${field.name}" takes at least one option; pass it in clear_issue_fields to clear it.`)
  }
  return [...new Set(names.map((name) => optionOf(field, name).id))]
}

function planValue(field: IssueFieldDefinition, value: IssueFieldValues[string]): IssueFieldWrite {
  if (field.type === "multi_select") return { fieldId: field.id, multiSelectOptionIds: multiOptionIdsOf(field, value) }
  if (Array.isArray(value)) {
    const options = field.type === "single_select" ? ` Options: ${listOf(field.options.map((each) => each.name))}.` : ""
    throw invalid(`"${field.name}" takes ${TAKES[field.type]}, not a list.${options}`)
  }
  switch (field.type) {
    case "text":
      return { fieldId: field.id, textValue: textOf(field.name, value, "text") }
    case "number":
      return { fieldId: field.id, numberValue: numberOf(field.name, value) }
    case "date":
      return { fieldId: field.id, dateValue: dateOf(field.name, value) }
    case "single_select":
      return { fieldId: field.id, singleSelectOptionId: optionOf(field, value).id }
  }
}

/**
 * Checks every issue field to set or clear against the definitions, by field name (without regard to
 * case): the field exists, the option exists, a number is a number, a date is a real `YYYY-MM-DD`, a
 * single select takes one option and a multi select at least one (repeats collapse), and no field is
 * named twice among the values and the fields to clear (a field to clear named twice counts once).
 * Anything else is `invalid_argument` naming the valid choices. Nothing to set or clear gives `[]`.
 */
export function planIssueFieldWrites(
  repo: RepoName,
  definitions: readonly IssueFieldDefinition[],
  values: Readonly<IssueFieldValues>,
  clear: readonly string[],
): IssueFieldWrite[] {
  const entries = Object.entries(values)
  if (entries.length === 0 && clear.length === 0) return []
  if (definitions.length === 0) {
    throw invalid(
      `${repo.full} has no issue fields: only an organization's repositories have them, when the organization defines some.`,
    )
  }

  const writes: IssueFieldWrite[] = []
  const set = new Set<string>()
  for (const [name, value] of entries) {
    const field = fieldOf(repo, definitions, name)
    if (set.has(field.id)) {
      throw invalid(`issue_fields names "${field.name}" twice; field names are matched without regard to case.`)
    }
    set.add(field.id)
    writes.push(planValue(field, value))
  }
  const cleared = new Set<string>()
  for (const name of clear) {
    const field = fieldOf(repo, definitions, name)
    if (set.has(field.id)) {
      throw invalid(`"${field.name}" is in both issue_fields and clear_issue_fields; pass it in one of them.`)
    }
    if (cleared.has(field.id)) continue
    cleared.add(field.id)
    writes.push({ fieldId: field.id, delete: true })
  }
  return writes
}

/** One write as a GraphQL input object literal; the values are checked, so the number is a finite one. */
function writeLiteral(write: IssueFieldWrite): string {
  const parts = [`fieldId:${lit(write.fieldId)}`]
  if (write.textValue !== undefined) parts.push(`textValue:${lit(write.textValue)}`)
  if (write.numberValue !== undefined) parts.push(`numberValue:${write.numberValue}`)
  if (write.dateValue !== undefined) parts.push(`dateValue:${lit(write.dateValue)}`)
  if (write.singleSelectOptionId !== undefined) parts.push(`singleSelectOptionId:${lit(write.singleSelectOptionId)}`)
  if (write.multiSelectOptionIds !== undefined) {
    parts.push(`multiSelectOptionIds:[${write.multiSelectOptionIds.map(lit).join(",")}]`)
  }
  if (write.delete) parts.push("delete:true")
  return `{${parts.join(",")}}`
}

/** Sets and clears the issue's fields in one call; nothing is sent for an empty list. A failure keeps the code `graphql` maps it to. */
export async function writeIssueFields(
  issueId: string,
  writes: readonly IssueFieldWrite[],
  ctx: RefContext,
): Promise<void> {
  if (writes.length === 0) return
  const inputs = writes.map(writeLiteral).join(",")
  await graphql(
    `mutation($issueId:ID!){setIssueFieldValue(input:{issueId:$issueId,issueFields:[${inputs}]}){issueFieldValues{__typename}}}`,
    { issueId },
    ctx,
  )
}

/** The values of the issue's fields by the issue's node id, as `issueFieldValues` maps them. */
export async function readIssueFieldValuesById(issueId: string, ctx: RefContext): Promise<IssueFieldValues> {
  const data = await graphql<{ node?: { issueFieldValues?: IssueFieldValueConnection } | null } | null>(
    VALUES_QUERY,
    { id: issueId },
    ctx,
  )
  return issueFieldValues(data?.node?.issueFieldValues)
}
