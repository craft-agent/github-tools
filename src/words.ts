import { mergeTranslations, type Translations } from "./core"
import { FACT_TRANSLATIONS } from "./core/facts"
import { ISSUE_TRANSLATIONS } from "./core/issues/words"
import { PROJECT_TRANSLATIONS } from "./core/projects/words"
import { PULL_REQUEST_TRANSLATIONS } from "./core/pull-requests/words"
import { RELEASE_TRANSLATIONS } from "./core/releases/words"
import { REPO_TRANSLATIONS } from "./core/repos/words"
import { RUN_TRANSLATIONS } from "./core/runs/words"
import { WORKFLOW_TRANSLATIONS } from "./core/workflows/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  ISSUE_TRANSLATIONS,
  PULL_REQUEST_TRANSLATIONS,
  PROJECT_TRANSLATIONS,
  REPO_TRANSLATIONS,
  RELEASE_TRANSLATIONS,
  RUN_TRANSLATIONS,
  WORKFLOW_TRANSLATIONS,
  FACT_TRANSLATIONS,
)
