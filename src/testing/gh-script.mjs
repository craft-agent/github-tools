#!/usr/bin/env node
/**
 * The fake `gh`: answers from rules.json next to this file and logs every call.
 * A plain Node script, so it runs wherever the tests do.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const joined = args.join(" ")
appendFileSync(join(dir, "calls.log"), `${JSON.stringify(args)}\n`)

const { rules, version } = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"))
const usedFile = join(dir, "used.json")
const used = existsSync(usedFile) ? JSON.parse(readFileSync(usedFile, "utf8")) : []

function reply({ stdout = "", stderr = "", code = 0 }) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exitCode = code
}

const index = rules.findIndex(
  (rule, i) => (rule.times === undefined || (used[i] ?? 0) < rule.times) && new RegExp(rule.match).test(joined),
)

if (index >= 0) {
  used[index] = (used[index] ?? 0) + 1
  writeFileSync(usedFile, JSON.stringify(used))
  if (rules[index].delayMs) await new Promise((resolve) => setTimeout(resolve, rules[index].delayMs))
  if (rules[index].killSelf) process.kill(process.pid, rules[index].killSelf)
  reply(rules[index])
} else if (joined === "--version") {
  reply({ stdout: `gh version ${version} (2026-01-01)\n` })
} else if (joined === "__env") {
  const names = ["GH_PROMPT_DISABLED", "NO_COLOR", "GH_REPO", "GH_PAGER"]
  reply({ stdout: JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))) })
} else {
  reply({ stderr: `fake gh: no rule for ${joined}`, code: 1 })
}
