import { git, gitOrThrow, globMatches, readGateConfig } from "@afk/pipeline";
import {
  applyReviewRevisionLimits,
  blameLinesFromPorcelain,
  isLockfilePath,
  isTestPath,
  parseTrailers,
  type ReviewAttribution,
  type ReviewBlob,
  type ReviewFile,
  type ReviewFileStatus,
  type ReviewHunk,
  type ReviewRevisionResult,
} from "@afk/shared";

const ZERO_SHA = "0".repeat(40);

const DIFF_FLAGS = [
  "-c",
  "diff.external=",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
] as const;

export interface ReviewRevisionTask {
  kind: "review-revision";
  pullId: number;
  repoUrl: string;
  repoName: string;
  defaultBranch: string;
  headSha: string;
  previousHeadSha: string | null;
}

function gitSafe(dir: string, args: string[]): string {
  return gitOrThrow(dir, ["-c", "diff.external=", ...args]);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function defaultTip(dir: string, defaultBranch: string): string {
  for (const ref of [
    `refs/heads/${defaultBranch}`,
    defaultBranch,
    `refs/remotes/origin/${defaultBranch}`,
    `origin/${defaultBranch}`,
  ]) {
    const resolved = git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (resolved.code === 0) return resolved.stdout.trim();
  }
  throw new Error(`could not resolve default branch ${defaultBranch}`);
}

function generatedGlobs(dir: string, headSha: string): string[] {
  try {
    return (readGateConfig(dir, headSha).generated ?? []).flatMap(
      (group) => group.paths,
    );
  } catch {
    return [];
  }
}

function isGeneratedPath(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globMatches(glob, path));
}

function mapStatus(
  code: string,
  srcMode: string,
  dstMode: string,
  oldBlob: string,
  newBlob: string,
): ReviewFileStatus {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "M" && srcMode !== dstMode && oldBlob === newBlob) return "mode";
  return "modified";
}

interface RawEntry {
  srcMode: string;
  dstMode: string;
  oldBlob: string;
  newBlob: string;
  code: string;
  oldPath: string | null;
  path: string;
}

function parseCombinedDiff(output: string): {
  entries: RawEntry[];
  stats: { additions: number; deletions: number; binary: boolean }[];
} {
  const parts = output.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  const entries: RawEntry[] = [];
  let i = 0;
  const header = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRTUX])(\d*)$/;
  while (i < parts.length) {
    const match = header.exec(parts[i] ?? "");
    if (!match) break;
    const code = match[5] as string;
    i += 1;
    let oldPath: string | null = null;
    let path: string;
    if (code === "R" || code === "C") {
      oldPath = parts[i] ?? "";
      i += 1;
      path = parts[i] ?? "";
      i += 1;
    } else {
      path = parts[i] ?? "";
      i += 1;
    }
    entries.push({
      srcMode: match[1] as string,
      dstMode: match[2] as string,
      oldBlob: match[3] as string,
      newBlob: match[4] as string,
      code,
      oldPath,
      path,
    });
  }
  const stats: { additions: number; deletions: number; binary: boolean }[] = [];
  while (i < parts.length) {
    const part = parts[i] ?? "";
    const binary = /^-\t-(\t|$)/.exec(part);
    const numbers = /^(\d+)\t(\d+)(\t|$)/.exec(part);
    if (!binary && !numbers) {
      i += 1;
      continue;
    }
    const pathOnLine = part.split("\t")[2];
    if (binary) {
      stats.push({ additions: 0, deletions: 0, binary: true });
    } else {
      stats.push({
        additions: Number(numbers?.[1]),
        deletions: Number(numbers?.[2]),
        binary: false,
      });
    }
    i += 1;
    if (!pathOnLine) {
      i += 2;
    }
  }
  return { entries, stats };
}

function attributionOf(message: string): ReviewAttribution {
  const trailers = parseTrailers(message);
  if (trailers.ticket) return { ticket: trailers.ticket };
  if (trailers.run) return { run: trailers.run };
  if (trailers.spec) return { kind: "planning" };
  return { kind: "setup" };
}

function attributionKey(item: ReviewAttribution): string {
  if ("ticket" in item) return `ticket:${item.ticket}`;
  if ("run" in item) return `run:${item.run}`;
  return `kind:${item.kind}`;
}

function uniqueAttributions(items: ReviewAttribution[]): ReviewAttribution[] {
  const seen = new Set<string>();
  const out: ReviewAttribution[] = [];
  for (const item of items) {
    const key = attributionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function fileAttributions(
  dir: string,
  mergeBase: string,
  headSha: string,
): {
  byPath: Map<string, ReviewAttribution[]>;
  byCommit: Map<string, ReviewAttribution>;
} {
  const byPath = new Map<string, ReviewAttribution[]>();
  const byCommit = new Map<string, ReviewAttribution>();
  const raw = gitSafe(dir, [
    "log",
    "--format=%x00%H%x00%B%x00",
    "--name-status",
    "-M",
    `${mergeBase}..${headSha}`,
  ]);
  const parts = raw.split("\0");
  let i = 0;
  if (parts[0] === "") i = 1;
  const add = (path: string, attr: ReviewAttribution) => {
    const list = byPath.get(path) ?? [];
    list.push(attr);
    byPath.set(path, list);
  };
  while (i + 1 < parts.length) {
    const sha = (parts[i] ?? "").trim();
    const body = parts[i + 1] ?? "";
    const filesPart = parts[i + 2] ?? "";
    i += 3;
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const attr = attributionOf(body);
    byCommit.set(sha, attr);
    for (const line of filesPart.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cols = trimmed.split("\t");
      const code = cols[0]?.[0];
      if (code === "R" || code === "C") {
        if (cols[1]) add(cols[1], attr);
        if (cols[2]) add(cols[2], attr);
      } else if (cols[cols.length - 1]) {
        add(cols[cols.length - 1] as string, attr);
      }
    }
  }
  return { byPath, byCommit };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(
  patch: string | null,
  blame: Map<number, { sha: string; boundary: boolean }>,
  byCommit: Map<string, ReviewAttribution>,
  fileAttrs: ReviewAttribution[],
): ReviewHunk[] | null {
  if (!patch) return null;
  const lines = patch.split("\n");
  const hunks: ReviewHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = HUNK_HEADER.exec(lines[i] ?? "");
    if (!header) {
      i += 1;
      continue;
    }
    const oldStart = Number(header[1]);
    const oldLines = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newLines = header[4] === undefined ? 1 : Number(header[4]);
    i += 1;
    let newLine = newStart;
    const counts = new Map<
      string,
      { attr: ReviewAttribution; lines: number }
    >();
    let added = 0;
    while (i < lines.length && !HUNK_HEADER.test(lines[i] ?? "")) {
      const line = lines[i] as string;
      if (line.startsWith("diff ") || line.startsWith("index ")) break;
      i += 1;
      if (line.startsWith("\\") || line.startsWith("diff")) continue;
      const mark = line[0];
      if (mark === "+") {
        added += 1;
        const blamed = blame.get(newLine);
        newLine += 1;
        if (!blamed || blamed.boundary) continue;
        const attr = byCommit.get(blamed.sha) ?? { kind: "unknown" as const };
        const key = attributionKey(attr);
        const prev = counts.get(key);
        if (prev) prev.lines += 1;
        else counts.set(key, { attr, lines: 1 });
      } else if (mark === " " || mark === undefined) {
        newLine += 1;
      }
    }
    let owners: Array<ReviewAttribution & { lines: number }>;
    if (counts.size > 0) {
      owners = [...counts.values()].map((item) => ({
        ...item.attr,
        lines: item.lines,
      }));
    } else if (added === 0) {
      if (fileAttrs.length === 1) {
        owners = [
          { ...fileAttrs[0], lines: oldLines } as ReviewAttribution & {
            lines: number;
          },
        ];
      } else {
        owners = [{ kind: "unknown", lines: oldLines }];
      }
    } else {
      owners = [];
    }
    hunks.push({
      newStart,
      newLines,
      oldStart,
      oldLines,
      owners,
    });
  }
  return hunks;
}

function patchOf(
  dir: string,
  mergeBase: string,
  headSha: string,
  path: string,
  oldPath: string | null,
): string | null {
  const args = [
    ...DIFF_FLAGS,
    "-M",
    "--abbrev=40",
    mergeBase,
    headSha,
    "--",
    ...(oldPath ? [oldPath, path] : [path]),
  ];
  const out = gitSafe(dir, args);
  return out === "" ? null : out;
}

function blobAt(dir: string, rev: string, path: string): string | null {
  const result = git(dir, ["rev-parse", "--verify", `${rev}:${path}`]);
  return result.code === 0 ? result.stdout.trim() : null;
}

function sincePatchOf(
  dir: string,
  previousHeadSha: string,
  headSha: string,
  path: string,
  oldPath: string | null,
  newBlob: string,
): string | null {
  const previous =
    blobAt(dir, previousHeadSha, path) ??
    (oldPath ? blobAt(dir, previousHeadSha, oldPath) : null);
  const previousBlob = previous ?? ZERO_SHA;
  if (previousBlob === newBlob) return null;
  const named = previous ? path : (oldPath ?? path);
  const out = gitSafe(dir, [
    ...DIFF_FLAGS,
    "-M",
    "--abbrev=40",
    previousHeadSha,
    headSha,
    "--",
    named,
  ]);
  return out === "" ? null : out;
}

function loadBlobs(dir: string, files: ReviewFile[]): ReviewBlob[] {
  const blobs: ReviewBlob[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (file.binary) continue;
    for (const sha of [file.oldBlob, file.newBlob]) {
      if (!sha || sha === ZERO_SHA || seen.has(sha)) continue;
      const size = git(dir, ["cat-file", "-s", sha]);
      if (size.code !== 0) continue;
      const bytes = Number(size.stdout.trim());
      if (!Number.isFinite(bytes)) continue;
      const raw = git(dir, ["cat-file", "blob", sha]);
      if (raw.code !== 0) continue;
      if (raw.stdout.includes("\0")) continue;
      seen.add(sha);
      blobs.push({ sha, content: raw.stdout, bytes: utf8Bytes(raw.stdout) });
    }
  }
  return blobs;
}

export function computeReviewRevision(
  repoDir: string,
  task: ReviewRevisionTask,
): ReviewRevisionResult {
  const baseSha = defaultTip(repoDir, task.defaultBranch);
  const mergeBase = gitSafe(repoDir, ["merge-base", baseSha, task.headSha]);
  const combined = gitSafe(repoDir, [
    ...DIFF_FLAGS,
    "-M",
    "--raw",
    "-z",
    "--numstat",
    "--abbrev=40",
    mergeBase,
    task.headSha,
  ]);
  const { entries, stats } = parseCombinedDiff(combined);
  const globs = generatedGlobs(repoDir, task.headSha);
  const { byPath, byCommit } = fileAttributions(
    repoDir,
    mergeBase,
    task.headSha,
  );

  const files: ReviewFile[] = entries.map((entry, index) => {
    const stat = stats[index] ?? {
      additions: 0,
      deletions: 0,
      binary: false,
    };
    const test = isTestPath(entry.path);
    const lockfile = isLockfilePath(entry.path);
    const generated = !test && isGeneratedPath(entry.path, globs);
    const status = mapStatus(
      entry.code,
      entry.srcMode,
      entry.dstMode,
      entry.oldBlob,
      entry.newBlob,
    );
    const attrs = uniqueAttributions([
      ...(byPath.get(entry.path) ?? []),
      ...(entry.oldPath ? (byPath.get(entry.oldPath) ?? []) : []),
    ]);
    const binary = stat.binary;
    const patch = binary
      ? null
      : patchOf(repoDir, mergeBase, task.headSha, entry.path, entry.oldPath);
    let hunks: ReviewHunk[] | null = null;
    if (!binary && patch) {
      const blamed = git(repoDir, [
        "-c",
        "diff.external=",
        "blame",
        "--porcelain",
        `${mergeBase}..${task.headSha}`,
        "--",
        entry.path,
      ]);
      const blameMap =
        blamed.code === 0 ? blameLinesFromPorcelain(blamed.stdout) : new Map();
      hunks = parseHunks(patch, blameMap, byCommit, attrs);
    }
    const sincePatch =
      task.previousHeadSha && !binary
        ? sincePatchOf(
            repoDir,
            task.previousHeadSha,
            task.headSha,
            entry.path,
            entry.oldPath,
            entry.newBlob,
          )
        : null;
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status,
      oldBlob: entry.oldBlob,
      newBlob: entry.newBlob,
      additions: stat.additions,
      deletions: stat.deletions,
      binary,
      generated,
      test,
      lockfile,
      patch,
      patchOmitted: binary ? "binary" : null,
      sincePatch,
      attributions: attrs,
      hunks,
    };
  });

  const blobs = loadBlobs(repoDir, files);
  const limited = applyReviewRevisionLimits({ files, blobs });
  const additions = limited.files.reduce(
    (sum, file) => sum + file.additions,
    0,
  );
  const deletions = limited.files.reduce(
    (sum, file) => sum + file.deletions,
    0,
  );
  return {
    stage: "review-revision",
    headSha: task.headSha,
    baseSha,
    mergeBaseSha: mergeBase,
    complete: limited.complete,
    omittedReason: limited.omittedReason,
    filesCount: limited.files.length,
    additions,
    deletions,
    files: limited.files,
    blobs: limited.blobs,
    done: true,
  };
}
