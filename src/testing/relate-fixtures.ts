import type { GhRule } from "./fake-gh"
import { gqlErrors, gqlReply } from "./gql"
import { DEPENDENCIES, brief, detailRule, rawIssue } from "./issue-fixtures"
import { REPOSITORY, repositoryRule } from "./write-fixtures"

/** Replies for the tests of the relate tool: issue 12 with the relations it holds now, and a second repository. */

export type CurrentRelations = {
  /** The numbers, in `octo/hello`, of the parent, sub-issues, blockers and blocked issues. */
  parent?: number
  subIssues?: number[]
  blockedBy?: number[]
  blocking?: number[]
  /** The dependencies read fails, as it does where GitHub has no such fields. */
  dependenciesError?: boolean
}

/** The detail and dependencies reads of issue 12, as GitHub returns them with these relations. */
export function relationsRules(current: CurrentRelations = {}): GhRule[] {
  const nodes = (numbers: number[] = []) => ({ nodes: numbers.map((number) => brief(number)) })
  return [
    detailRule(
      rawIssue({
        parent: current.parent === undefined ? null : brief(current.parent),
        subIssues: nodes(current.subIssues),
      }),
    ),
    {
      match: DEPENDENCIES,
      stdout: current.dependenciesError
        ? gqlErrors([{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }])
        : gqlReply({
            repository: {
              issue: { blockedBy: nodes(current.blockedBy), blocking: nodes(current.blocking) },
            },
          }),
    },
  ]
}

/** The repository query of a repository other than `octo/hello`; it must come before `repositoryRule()`, which answers any. */
export function otherRepositoryRule(
  repo: string,
  options: { permission?: string | null; viewer?: string; id?: string } = {},
): GhRule {
  const { id, ...asked } = options
  const [owner, name] = repo.split("/")
  const rule = repositoryRule({ repo, ...asked })
  const reply = JSON.parse(rule.stdout ?? "")
  if (id !== undefined) reply.data.repository.id = id
  return { ...rule, stdout: JSON.stringify(reply), match: `${REPOSITORY}[\\s\\S]*owner=${owner} -f name=${name}` }
}
