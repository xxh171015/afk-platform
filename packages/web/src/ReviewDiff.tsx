import { parsePatch } from "diff";
import { useState } from "react";
import { cn } from "./lib/utils.ts";
import {
  hunkTickets,
  omittedReason,
  ownerLabels,
  type ReviewFileView,
} from "./review-model.ts";

export function parsedHunks(patch: string | null): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}[] {
  if (!patch) return [];
  return (parsePatch(patch)[0]?.hunks ?? []).map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}

function blobSha(file: ReviewFileView): string | null {
  if (file.status === "deleted") return file.oldBlob || null;
  return file.newBlob || null;
}

function hunkSpan(
  file: ReviewFileView,
  hunk: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  },
): { start: number; end: number } {
  if (file.status === "deleted") {
    return {
      start: hunk.oldStart,
      end: hunk.oldStart + Math.max(hunk.oldLines, 1) - 1,
    };
  }
  return {
    start: hunk.newStart,
    end: hunk.newStart + Math.max(hunk.newLines, 1) - 1,
  };
}

function isHiddenHunk(
  file: ReviewFileView,
  hunk: { newStart: number },
  highlightTicket: string | null,
): boolean {
  if (highlightTicket === null) return false;
  const meta = file.hunks?.find((item) => item.newStart === hunk.newStart);
  if (!meta) return false;
  return !hunkTickets(meta.owners).includes(highlightTicket);
}

export type DiffLineNumbers = {
  text: string;
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  excerpt: string;
};

export function numberedDiffLines(hunk: {
  oldStart: number;
  newStart: number;
  lines: string[];
}): DiffLineNumbers[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((text) => {
    const kind: DiffLineNumbers["kind"] =
      text.startsWith("+") && !text.startsWith("+++")
        ? "add"
        : text.startsWith("-") && !text.startsWith("---")
          ? "del"
          : "ctx";
    const excerpt = text.length > 0 ? text.slice(1) : "";
    if (kind === "add") {
      const row = { text, kind, oldNo: null, newNo, excerpt };
      newNo += 1;
      return row;
    }
    if (kind === "del") {
      const row = { text, kind, oldNo, newNo: null, excerpt };
      oldNo += 1;
      return row;
    }
    const row = { text, kind, oldNo, newNo, excerpt };
    oldNo += 1;
    newNo += 1;
    return row;
  });
}

export function firstCommentLine(
  patch: string | null,
  hunkIndex: number,
): { side: "old" | "new"; line: number; excerpt: string } | null {
  const hunk = parsedHunks(patch)[hunkIndex];
  if (!hunk) return null;
  const rows = numberedDiffLines(hunk);
  const added = rows.find((row) => row.kind === "add" && row.newNo != null);
  if (added?.newNo != null)
    return { side: "new", line: added.newNo, excerpt: added.excerpt };
  const anyNew = rows.find((row) => row.newNo != null);
  if (anyNew?.newNo != null)
    return { side: "new", line: anyNew.newNo, excerpt: anyNew.excerpt };
  const anyOld = rows.find((row) => row.oldNo != null);
  if (anyOld?.oldNo != null)
    return { side: "old", line: anyOld.oldNo, excerpt: anyOld.excerpt };
  return null;
}

export function ReviewDiff({
  file,
  patch,
  highlightTicket,
  hostUrl,
  hunkIndex,
  canComment,
  onCommentLine,
  onLoadContext,
}: {
  file: ReviewFileView;
  patch: string | null;
  highlightTicket: string | null;
  hostUrl: string;
  hunkIndex: number;
  canComment?: boolean;
  onCommentLine?: (input: {
    side: "old" | "new";
    line: number;
    excerpt: string;
  }) => void;
  onLoadContext: (input: {
    sha: string;
    from: number;
    to: number;
  }) => Promise<{ stored: boolean; lines: string[] }>;
}) {
  const reason = omittedReason(file.patchOmitted);
  const hunks = parsedHunks(patch);
  const [extra, setExtra] = useState<
    Record<number, { above: string[]; below: string[]; missing?: boolean }>
  >({});
  const sha = blobSha(file);

  const expand = async (
    index: number,
    side: "above" | "below",
    mode: "20" | "gap" | "all",
  ) => {
    const hunk = hunks[index];
    if (!hunk || !sha) return;
    const span = hunkSpan(file, hunk);
    let from: number;
    let to: number;
    if (side === "above") {
      to = span.start - 1;
      if (to < 1) return;
      const prev = hunks[index - 1];
      const floor = prev ? hunkSpan(file, prev).end + 1 : 1;
      from = mode === "gap" ? floor : Math.max(floor, span.start - 20);
    } else {
      from = span.end + 1;
      const next = hunks[index + 1];
      const ceiling = next ? hunkSpan(file, next).start - 1 : from + 10_000;
      if (mode === "all") to = Math.min(ceiling, from + 10_000);
      else if (mode === "gap") to = next ? ceiling : from + 10_000;
      else to = Math.min(ceiling, from + 19);
    }
    if (to < from) return;
    const got = await onLoadContext({ sha, from, to });
    setExtra((current) => {
      const prev = current[index] ?? { above: [], below: [] };
      if (!got.stored)
        return { ...current, [index]: { ...prev, missing: true } };
      return {
        ...current,
        [index]: {
          ...prev,
          [side]: got.lines,
        },
      };
    });
  };

  if (reason) {
    return (
      <p className="note text-sm">
        {reason}{" "}
        <a href={hostUrl} target="_blank" rel="noreferrer">
          到托管上看
        </a>
      </p>
    );
  }

  if (!patch) {
    return <p className="note text-sm">没有 diff</p>;
  }

  const nodes = [];
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    if (isHiddenHunk(file, hunk, highlightTicket)) {
      let count = 1;
      const labels = new Set(
        ownerLabels(
          file.hunks?.find((item) => item.newStart === hunk.newStart)?.owners ??
            [],
        ),
      );
      while (
        index + 1 < hunks.length &&
        isHiddenHunk(file, hunks[index + 1], highlightTicket)
      ) {
        index += 1;
        count += 1;
        for (const label of ownerLabels(
          file.hunks?.find((item) => item.newStart === hunks[index].newStart)
            ?.owners ?? [],
        )) {
          labels.add(label);
        }
      }
      nodes.push(
        <p
          key={`fold-${hunk.newStart}-${index}`}
          className="px-3 py-1 text-muted-foreground"
        >
          另有 {count} 段属于 {[...labels].join("、") || "未知"}
        </p>,
      );
      continue;
    }
    const current = index === hunkIndex;
    const extraHunk = extra[index];
    const span = hunkSpan(file, hunk);
    const prev = hunks[index - 1];
    const next = hunks[index + 1];
    const canAbove = span.start > 1;
    const gapAbove = prev != null && hunkSpan(file, prev).end + 1 < span.start;
    const gapBelow = next != null && span.end + 1 < hunkSpan(file, next).start;
    const last = next == null;
    nodes.push(
      <section
        key={`${hunk.newStart}-${index}`}
        data-hunk={index}
        data-current={current ? "true" : undefined}
        className={cn("border-t", current && "bg-accent/40")}
      >
        <header className="flex flex-wrap items-center gap-2 bg-surface px-3 py-1 text-muted-foreground">
          <span>
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{" "}
            @@
          </span>
          {!sha || extraHunk?.missing ? (
            <span>
              文件太大，到托管上看全文{" "}
              <a href={hostUrl} target="_blank" rel="noreferrer">
                到托管上看
              </a>
            </span>
          ) : (
            <>
              {canAbove ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => void expand(index, "above", "20")}
                >
                  向上展开 20 行
                </button>
              ) : null}
              {gapAbove ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => void expand(index, "above", "gap")}
                >
                  展开到上一个 hunk
                </button>
              ) : null}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => void expand(index, "below", "20")}
              >
                向下展开 20 行
              </button>
              {gapBelow ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => void expand(index, "below", "gap")}
                >
                  展开到下一个 hunk
                </button>
              ) : null}
              {last ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => void expand(index, "below", "all")}
                >
                  展开全部
                </button>
              ) : null}
            </>
          )}
        </header>
        {keyedLines(`a-${span.start}`, extraHunk?.above ?? []).map(
          ({ key, line }) => (
            <DiffLine
              key={key}
              path={file.path}
              text={` ${line}`}
              oldNo={null}
              newNo={null}
            />
          ),
        )}
        {numberedDiffLines(hunk).map((row) => (
          <DiffLine
            key={`${row.oldNo ?? "o"}:${row.newNo ?? "n"}:${row.text}`}
            path={file.path}
            text={row.text}
            oldNo={row.oldNo}
            newNo={row.newNo}
            excerpt={row.excerpt}
            canComment={canComment}
            onCommentLine={onCommentLine}
          />
        ))}
        {keyedLines(`b-${span.end}`, extraHunk?.below ?? []).map(
          ({ key, line }) => (
            <DiffLine
              key={key}
              path={file.path}
              text={` ${line}`}
              oldNo={null}
              newNo={null}
            />
          ),
        )}
      </section>,
    );
  }
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {nodes}
    </div>
  );
}

function keyedLines(prefix: string, lines: string[]) {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    return { key: `${prefix}:${n}:${line}`, line };
  });
}

function LineNo({
  path,
  side,
  n,
  excerpt,
  canComment,
  onCommentLine,
}: {
  path: string;
  side: "old" | "new";
  n: number | null;
  excerpt: string;
  canComment?: boolean;
  onCommentLine?: (input: {
    side: "old" | "new";
    line: number;
    excerpt: string;
  }) => void;
}) {
  if (n == null) {
    return <span className="w-8 shrink-0 text-right text-subtle-foreground" />;
  }
  if (canComment && onCommentLine) {
    return (
      <button
        type="button"
        aria-label={`写意见 ${path} ${side === "new" ? "新侧" : "旧侧"}第 ${n} 行`}
        className="w-8 shrink-0 text-right text-subtle-foreground hover:text-primary hover:underline"
        onClick={() => onCommentLine({ side, line: n, excerpt })}
      >
        {n}
      </button>
    );
  }
  return (
    <span className="w-8 shrink-0 text-right text-subtle-foreground">{n}</span>
  );
}

function DiffLine({
  path,
  text,
  oldNo,
  newNo,
  excerpt,
  canComment,
  onCommentLine,
}: {
  path: string;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  excerpt?: string;
  canComment?: boolean;
  onCommentLine?: (input: {
    side: "old" | "new";
    line: number;
    excerpt: string;
  }) => void;
}) {
  const kind =
    text.startsWith("+") && !text.startsWith("+++")
      ? "add"
      : text.startsWith("-") && !text.startsWith("---")
        ? "del"
        : "ctx";
  const body = text.length > 0 ? text.slice(1) : "";
  const lineExcerpt = excerpt ?? body;
  return (
    <div
      className={cn(
        "flex whitespace-pre px-3",
        kind === "add" && "bg-state-done/12",
        kind === "del" && "bg-state-blocked/12",
      )}
    >
      <LineNo
        path={path}
        side="old"
        n={oldNo}
        excerpt={lineExcerpt}
        canComment={canComment}
        onCommentLine={onCommentLine}
      />
      <LineNo
        path={path}
        side="new"
        n={newNo}
        excerpt={lineExcerpt}
        canComment={canComment}
        onCommentLine={onCommentLine}
      />
      <span>
        {kind === "add" ? "+" : kind === "del" ? "-" : " "}
        {body}
      </span>
    </div>
  );
}
