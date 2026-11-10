import { createHash } from "node:crypto"
import type { CallFact } from "./tool"
import type { Translations } from "./words"

/** The facts the write tools of several toolsets share in a call's description, and the words they and their labels use. */

const MINUS = "\u2212"

/** The states a fact shows as a word of the tool's, by the lower-case word GitHub's state becomes. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  draft: "Draft",
}

/** The `State` fact: a known state as a template value (`Open`), any other string as it is. */
export function stateFact(state: string): CallFact {
  const word = Object.hasOwn(STATE_WORDS, state) ? STATE_WORDS[state] : undefined
  return { label: "State", value: word === undefined ? state : { text: word } }
}

/** How the `State` fact words a project item or a repository that is not archived, when the call would unarchive it. */
export const NOT_ARCHIVED = "Not archived; nothing is sent"

/** How the `State` fact words an edit that finds everything in place. */
export const NOTHING_CHANGED = "Already in place; nothing is sent"

/** A fact that lists a change as `+added −removed`, or `undefined` when nothing is added or removed. */
export function changeFact(
  label: string,
  added: readonly string[],
  removed: readonly string[] = [],
): CallFact | undefined {
  const changes = [...added.map((name) => `+${name}`), ...removed.map((name) => `${MINUS}${name}`)]
  return changes.length === 0 ? undefined : { label, value: changes.join(" ") }
}

/** The lowercase hex SHA-256 of a text, for a pin that stands for a value the prompt does not show. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** The Japanese of the facts and words that more than one toolset's descriptions write. */
export const WRITE_FACT_TRANSLATIONS: Translations = {
  ja: {
    State: "状態",
    Open: "オープン",
    Closed: "クローズ",
    Merged: "マージ済み",
    Draft: "ドラフト",
    Comment: "コメント",
    Title: "タイトル",
    Body: "本文",
    Labels: "ラベル",
    Assignees: "担当者",
    Milestone: "マイルストーン",
    Base: "ベース",
    Branch: "ブランチ",
    Board: "ボード",
    Kind: "種類",
    "Issue body": "Issue の本文",
    "{name} (new)": "{name}（新規作成）",
    "New body": "新しい本文",
    "Appended text": "追記する本文",
    Replaced: "置き換え",
    Cleared: "空にする",
    Appended: "追記",
    Removed: "解除",
    "Already closed; nothing is sent": "すでにクローズ済みです（何も送信されません）",
    "Already open; nothing is sent": "すでにオープン中です（何も送信されません）",
    Template: "テンプレート",
    Tag: "タグ",
    Commit: "コミット",
    On: "オン",
    Off: "オフ",
    [NOTHING_CHANGED]: "すでに反映済みです（何も送信されません）",
    [NOT_ARCHIVED]: "アーカイブされていません（何も送信されません）",
  },
}
