import type { Translations } from "../words"

/** The Japanese of the workflow run tools' titles and intents. */
export const RUN_TRANSLATIONS: Translations = {
  ja: {
    "Re-run a workflow run": "ワークフローの実行を再実行する",
    "About to re-run a workflow run": "ワークフローの実行を再実行しようとしています",
    "Cancel a workflow run": "ワークフローの実行をキャンセルする",
    "About to cancel a workflow run": "ワークフローの実行をキャンセルしようとしています",
    "About to cancel the run of the workflow {name}":
      "GitHub Actions のワークフロー「{name}」の実行をキャンセルしようとしています",
    "About to re-run the workflow {name}": "GitHub Actions のワークフロー「{name}」を再実行しようとしています",
    Event: "イベント",
    Status: "状況",
    Queued: "キュー待ち",
    "In progress": "実行中",
    Scope: "再実行の範囲",
    "Failed jobs only": "失敗したジョブのみ",
    "One job": "1 つのジョブ",
    "All jobs": "すべてのジョブ",
    Job: "ジョブ",
    "Debug logging": "デバッグログ",
  },
}
