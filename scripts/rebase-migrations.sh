#!/usr/bin/env bash
# Put this ticket's new drizzle migrations after the integration branch's latest number.
# Intended for the gate sandbox on a generated-only ours-merge (HEAD has two parents).
# Does not rerun drizzle-kit: handwritten trigger SQL (0035 and later) would be lost.
# Does not touch snapshot files: this repo has none after 0022.
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "rebase-migrations: not a git work tree" >&2
  exit 1
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

export AFK_REBASE_DRIZZLE="${AFK_REBASE_DRIZZLE:-packages/api/drizzle}"
if [[ ! -f "$AFK_REBASE_DRIZZLE/meta/_journal.json" ]]; then
  exit 0
fi

# commit parent1 parent2 → three words when HEAD is a merge
# shellcheck disable=SC2046
set -- $(git rev-list --parents -n 1 HEAD)
if [[ $# -lt 3 ]]; then
  exit 0
fi
export AFK_REBASE_INTEGRATION="$2"
export AFK_REBASE_INCOMING="$3"

exec node --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const drizzle = process.env.AFK_REBASE_DRIZZLE;
const integration = process.env.AFK_REBASE_INTEGRATION;
const incoming = process.env.AFK_REBASE_INCOMING;
if (!drizzle || !integration || !incoming) {
  console.error("rebase-migrations: missing integration or incoming commit");
  process.exit(1);
}
const journalPath = `${drizzle}/meta/_journal.json`;

const git = (args, encoding = "utf8") =>
  execFileSync("git", args, { encoding, maxBuffer: 32 << 20 });

const base = git(["merge-base", integration, incoming]).trim();
const added = git([
  "diff",
  "--name-only",
  "--diff-filter=A",
  base,
  incoming,
  "--",
  drizzle,
])
  .trim()
  .split("\n")
  .filter(Boolean);
const escaped = drizzle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sqlPath = new RegExp(`^${escaped}/\\d{4}_[^/]+\\.sql$`);
const addedSql = added.filter((file) => sqlPath.test(file));
if (addedSql.length === 0) process.exit(0);

const show = (rev, path) =>
  execFileSync("git", ["show", `${rev}:${path}`], { maxBuffer: 32 << 20 });

const has = (rev, path) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}:${path}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const integrationJournal = JSON.parse(show(integration, journalPath).toString());
let incomingOrder = [];
try {
  incomingOrder = JSON.parse(show(incoming, journalPath).toString()).entries.map(
    (entry) => entry.tag,
  );
} catch {
  incomingOrder = [];
}

const tagOf = (file) => basename(file, ".sql");
addedSql.sort((a, b) => {
  const ia = incomingOrder.indexOf(tagOf(a));
  const ib = incomingOrder.indexOf(tagOf(b));
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
});

const entries = integrationJournal.entries;
if (!Array.isArray(entries) || entries.length === 0) {
  console.error("rebase-migrations: integration journal has no entries");
  process.exit(1);
}
const last = entries.at(-1);
let nextIdx = last.idx + 1;
let nextWhen = last.when + 1;
let nextNum =
  Math.max(
    ...entries.map((entry) => Number.parseInt(String(entry.tag).slice(0, 4), 10)),
  ) + 1;

for (const oldPath of addedSql) {
  const oldTag = tagOf(oldPath);
  const suffix = oldTag.replace(/^\d{4}_/, "");
  const newTag = `${String(nextNum).padStart(4, "0")}_${suffix}`;
  const newPath = `${drizzle}/${newTag}.sql`;
  const content = show(incoming, oldPath);
  mkdirSync(dirname(newPath), { recursive: true });
  writeFileSync(newPath, content);
  if (oldPath !== newPath && existsSync(oldPath) && !has(integration, oldPath)) {
    unlinkSync(oldPath);
  }
  entries.push({
    idx: nextIdx,
    version: last.version,
    when: nextWhen,
    tag: newTag,
    breakpoints: last.breakpoints ?? true,
  });
  process.stderr.write(`rebase-migrations: ${oldTag}.sql -> ${newTag}.sql\n`);
  nextIdx += 1;
  nextWhen += 1;
  nextNum += 1;
}

writeFileSync(
  journalPath,
  `${JSON.stringify(integrationJournal, null, 2)}\n`,
);
NODE
