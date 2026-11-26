import {
  type DecisionKind,
  formatDisplayId,
  itemsFromRun,
  type RulingVerdict,
  rulingsOf,
} from "@afk/shared";
import { userStoriesOf } from "@afk/shared/user-stories";
import type pg from "pg";
import { readAcceptancePack } from "../acceptance/pack.ts";

const TICKET_CODE_STAGES = new Set([
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
]);

const WRAP_UP_STAGES = [
  "final-fix",
  "rework",
  "final-tidy",
  "update-branch",
] as const;
export type WrapUpStage = (typeof WRAP_UP_STAGES)[number];

function isWrapUpStage(stage: string | undefined): stage is WrapUpStage {
  return (WRAP_UP_STAGES as readonly string[]).includes(stage ?? "");
}

export type ReviewGuideHunk = {
  fileId: number;
  path: string;
  newStart: number;
  newLines: number;
  oldStart: number;
  oldLines: number;
  lines: number;
};

export type ReviewGuideSummary = {
  run: string;
  stage: string;
  summary: string;
};

export type ReviewGuideDecision = {
  id: string;
  kind: DecisionKind;
  text: string;
  ref?: string;
  run: string;
  stage: string;
};

export type ReviewGuideRuling = {
  id: string;
  verdict: RulingVerdict;
};

export type ReviewGuideCriterion = {
  text: string;
  tests: string[];
  status: "verified" | "unverified";
  reason: string | null;
};

export type ReviewGuideTicket = {
  id: number;
  displayId: string;
  title: string;
  appended: boolean;
  stories: { number: number; text: string }[];
  criteria: ReviewGuideCriterion[];
  summaries: ReviewGuideSummary[];
  decisions: ReviewGuideDecision[];
  rulings: ReviewGuideRuling[];
  hunks: ReviewGuideHunk[];
  viewed: boolean;
};

export type ReviewGuideView = {
  revisionId: number;
  unattributedCount: number;
  spec: {
    id: number;
    displayId: string;
    title: string;
    type: string;
    userStories: { number: number; text: string }[];
    sourceSpec: { id: number; displayId: string; title: string } | null;
  };
  tickets: ReviewGuideTicket[];
  otherRepoTickets: {
    displayId: string;
    title: string;
    repo: string;
    pullRequestId: number | null;
  }[];
  wrapUp: {
    stage: WrapUpStage;
    summaries: ReviewGuideSummary[];
    hunks: ReviewGuideHunk[];
    viewed: boolean;
  }[];
  changeRequests: {
    number: number;
    comments: { displayId: string; body: string }[];
    dispositions: { displayId: string; result: string }[];
    hunks: ReviewGuideHunk[];
  }[];
  setup: ReviewGuideHunk[];
  planning: ReviewGuideHunk[];
  unattributed: { path: string; hunks: ReviewGuideHunk[] }[];
};

type RunRow = {
  id: number;
  stage: string;
  ticketId: number | null;
  axis: string | null;
  result: string | null;
  output: unknown;
  finishedAt: Date | null;
};

function summaryOf(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const summary = (output as { summary?: unknown }).summary;
  if (typeof summary !== "string") return null;
  const trimmed = summary.trim();
  return trimmed === "" ? null : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asHunks(raw: unknown):
  | {
      newStart: number;
      newLines: number;
      oldStart: number;
      oldLines: number;
      owners: Record<string, unknown>[];
    }[]
  | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const hunks: {
    newStart: number;
    newLines: number;
    oldStart: number;
    oldLines: number;
    owners: Record<string, unknown>[];
  }[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const owners = Array.isArray(rec.owners)
      ? rec.owners
          .map(asRecord)
          .filter((owner): owner is Record<string, unknown> => owner != null)
      : [];
    hunks.push({
      newStart: Number(rec.newStart) || 0,
      newLines: Number(rec.newLines) || 0,
      oldStart: Number(rec.oldStart) || 0,
      oldLines: Number(rec.oldLines) || 0,
      owners,
    });
  }
  return hunks;
}

function asAttributions(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item != null);
}

function ownerLines(owner: Record<string, unknown>, fallback: number): number {
  return typeof owner.lines === "number" ? owner.lines : fallback;
}

type Placement =
  | { type: "ticket"; displayId: string }
  | { type: "wrap"; stage: WrapUpStage }
  | { type: "setup" }
  | { type: "planning" }
  | { type: "unattributed" };

function placementsOf(
  owners: Record<string, unknown>[],
  runByDisplay: Map<string, RunRow>,
  ticketDisplayIds: Set<string>,
): Placement[] {
  const found: Placement[] = [];
  const seen = new Set<string>();
  const add = (key: string, placement: Placement) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push(placement);
  };
  for (const owner of owners) {
    if (
      typeof owner.ticket === "string" &&
      ticketDisplayIds.has(owner.ticket)
    ) {
      add(`ticket:${owner.ticket}`, {
        type: "ticket",
        displayId: owner.ticket,
      });
      continue;
    }
    if (typeof owner.run === "string") {
      const run = runByDisplay.get(owner.run);
      const stage = typeof owner.stage === "string" ? owner.stage : run?.stage;
      if (isWrapUpStage(stage)) {
        add(`wrap:${stage}`, { type: "wrap", stage });
        continue;
      }
      if (run?.ticketId != null) {
        const displayId = formatDisplayId("ticket", run.ticketId);
        if (ticketDisplayIds.has(displayId)) {
          add(`ticket:${displayId}`, { type: "ticket", displayId });
          continue;
        }
      }
      add("unattributed", { type: "unattributed" });
      continue;
    }
    if (owner.kind === "setup") {
      add("setup", { type: "setup" });
      continue;
    }
    if (owner.kind === "planning") {
      add("planning", { type: "planning" });
      continue;
    }
    add("unattributed", { type: "unattributed" });
  }
  const attributed = found.filter((item) => item.type !== "unattributed");
  if (attributed.length > 0) return attributed;
  return found.length > 0 ? found : [{ type: "unattributed" }];
}

function topoTicketIds(
  ids: number[],
  edges: { from: number; to: number }[],
): number[] {
  const idSet = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, [] as number[]]));
  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const result: number[] = [];
  let ready = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);
  while (ready.length > 0) {
    result.push(...ready);
    const next: number[] = [];
    for (const id of ready) {
      for (const dest of outgoing.get(id) ?? []) {
        const remaining = (indegree.get(dest) ?? 1) - 1;
        indegree.set(dest, remaining);
        if (remaining === 0) next.push(dest);
      }
    }
    ready = next.sort((a, b) => a - b);
  }
  const leftover = ids
    .filter((id) => !result.includes(id))
    .sort((a, b) => a - b);
  return [...result, ...leftover];
}

function guideHunk(
  fileId: number,
  path: string,
  input: {
    newStart: number;
    newLines: number;
    oldStart: number;
    oldLines: number;
    owners: Record<string, unknown>[];
  },
): ReviewGuideHunk {
  const lines =
    input.owners.length > 0
      ? input.owners.reduce((sum, owner) => sum + ownerLines(owner, 0), 0) ||
        input.newLines
      : input.newLines;
  return {
    fileId,
    path,
    newStart: input.newStart,
    newLines: input.newLines,
    oldStart: input.oldStart,
    oldLines: input.oldLines,
    lines,
  };
}

function summariesOf(
  runs: RunRow[],
  stages: ReadonlySet<string>,
): ReviewGuideSummary[] {
  const rows: {
    finishedAt: number;
    id: number;
    summary: ReviewGuideSummary;
  }[] = [];
  for (const run of runs) {
    if (run.result !== "done") continue;
    if (!stages.has(run.stage)) continue;
    const summary = summaryOf(run.output);
    if (!summary) continue;
    rows.push({
      finishedAt: run.finishedAt?.getTime() ?? 0,
      id: run.id,
      summary: {
        run: formatDisplayId("run", run.id),
        stage: run.stage,
        summary,
      },
    });
  }
  rows.sort((a, b) => b.finishedAt - a.finishedAt || b.id - a.id);
  return rows.map((row) => row.summary);
}

function sectionViewed(
  hunks: ReviewGuideHunk[],
  viewedPaths: Set<string>,
): boolean {
  if (hunks.length === 0) return false;
  return hunks.every((hunk) => viewedPaths.has(hunk.path));
}

function overlayViewed(
  guide: ReviewGuideView,
  viewedPaths: Set<string>,
): ReviewGuideView {
  return {
    ...guide,
    changeRequests: [],
    tickets: guide.tickets.map((ticket) => ({
      ...ticket,
      viewed: sectionViewed(ticket.hunks, viewedPaths),
    })),
    wrapUp: guide.wrapUp.map((section) => ({
      ...section,
      viewed: sectionViewed(section.hunks, viewedPaths),
    })),
  };
}

async function viewedPathsOf(
  db: Pick<pg.Pool, "query">,
  revisionId: number,
  pullId: number,
): Promise<Set<string>> {
  const viewed = await db.query<{ path: string }>(
    `SELECT f.path FROM review_files f
     JOIN review_file_views v
       ON v.pull_request_id = $2 AND v.path = f.path AND v.new_blob = f.new_blob
     WHERE f.revision_id = $1`,
    [revisionId, pullId],
  );
  return new Set(viewed.rows.map((row) => row.path));
}

async function assembleGuide(
  db: Pick<pg.Pool, "query">,
  input: {
    revisionId: number;
    specId: number;
    repo: string;
  },
): Promise<ReviewGuideView> {
  const spec = await db.query<{
    id: number;
    title: string;
    type: string;
    body: string;
    source_id: number | null;
    source_title: string | null;
  }>(
    `SELECT s.id, s.title, s.type, s.body,
            src.id AS source_id, src.title AS source_title
     FROM specs s
     LEFT JOIN specs src ON src.id = s.source_spec_id
     WHERE s.id = $1`,
    [input.specId],
  );
  const specRow = spec.rows[0];
  if (!specRow) {
    throw new Error(`spec ${input.specId} missing for review revision`);
  }
  const userStories = userStoriesOf(specRow.body);
  const storyText = new Map(userStories.map((story) => [story.number, story]));
  const tickets = await db.query<{
    id: number;
    title: string;
    stories: number[] | null;
    acceptance_criteria: string[] | null;
    appended: boolean;
    repo: string;
    repo_id: number;
  }>(
    `SELECT t.id, t.title, t.stories, t.acceptance_criteria, t.appended,
            r.name AS repo, t.repo_id
     FROM tickets t JOIN repos r ON r.id = t.repo_id
     WHERE t.spec_id = $1
     ORDER BY t.id`,
    [input.specId],
  );
  const edges = await db.query<{
    from_ticket_id: number;
    to_ticket_id: number;
  }>(
    `SELECT e.from_ticket_id, e.to_ticket_id FROM edges e
     JOIN tickets t ON t.id = e.to_ticket_id
     WHERE t.spec_id = $1`,
    [input.specId],
  );
  const pulls = await db.query<{ id: number; repo_id: number }>(
    "SELECT id, repo_id FROM pull_requests WHERE spec_id = $1",
    [input.specId],
  );
  const pullByRepo = new Map(pulls.rows.map((row) => [row.repo_id, row.id]));
  const files = await db.query<{
    id: number;
    path: string;
    additions: number;
    deletions: number;
    attributions: unknown;
    hunks: unknown;
  }>(
    `SELECT id, path, additions, deletions, attributions, hunks
     FROM review_files WHERE revision_id = $1 ORDER BY path`,
    [input.revisionId],
  );
  const runs = await db.query<{
    id: number;
    stage: string;
    ticket_id: number | null;
    axis: string | null;
    result: string | null;
    output: unknown;
    finished_at: Date | null;
  }>(
    `SELECT id, stage, ticket_id, axis, result, output, finished_at
     FROM runs WHERE spec_id = $1 ORDER BY id`,
    [input.specId],
  );
  const runRows: RunRow[] = runs.rows.map((row) => ({
    id: row.id,
    stage: row.stage,
    ticketId: row.ticket_id,
    axis: row.axis,
    result: row.result,
    output: row.output,
    finishedAt: row.finished_at,
  }));
  const runByDisplay = new Map(
    runRows.map((run) => [formatDisplayId("run", run.id), run] as const),
  );
  const ticketDisplayIds = new Set(
    tickets.rows.map((ticket) => formatDisplayId("ticket", ticket.id)),
  );
  const pack = await readAcceptancePack(db, input.specId);
  const criteriaByTicket = new Map<string, ReviewGuideCriterion[]>();
  for (const repo of pack?.repos ?? []) {
    for (const ticket of repo.tickets) {
      criteriaByTicket.set(ticket.displayId, ticket.criteria);
    }
  }

  const ticketHunks = new Map<string, ReviewGuideHunk[]>();
  const wrapHunks = new Map<WrapUpStage, ReviewGuideHunk[]>();
  const setup: ReviewGuideHunk[] = [];
  const planning: ReviewGuideHunk[] = [];
  const unattributedByPath = new Map<string, ReviewGuideHunk[]>();
  const addTicketHunk = (displayId: string, hunk: ReviewGuideHunk) => {
    const list = ticketHunks.get(displayId) ?? [];
    list.push(hunk);
    ticketHunks.set(displayId, list);
  };
  const addWrapHunk = (stage: WrapUpStage, hunk: ReviewGuideHunk) => {
    const list = wrapHunks.get(stage) ?? [];
    list.push(hunk);
    wrapHunks.set(stage, list);
  };
  const addUnattributed = (hunk: ReviewGuideHunk) => {
    const list = unattributedByPath.get(hunk.path) ?? [];
    list.push(hunk);
    unattributedByPath.set(hunk.path, list);
  };

  for (const file of files.rows) {
    const parsed = asHunks(file.hunks);
    const fileAttrs = asAttributions(file.attributions);
    const units =
      parsed && parsed.length > 0
        ? parsed.map((hunk) => ({
            hunk: guideHunk(file.id, file.path, hunk),
            owners: hunk.owners,
          }))
        : [
            {
              hunk: guideHunk(file.id, file.path, {
                newStart: 1,
                newLines: file.additions,
                oldStart: 1,
                oldLines: file.deletions,
                owners: fileAttrs,
              }),
              owners: fileAttrs,
            },
          ];
    for (const unit of units) {
      const placements = placementsOf(
        unit.owners,
        runByDisplay,
        ticketDisplayIds,
      );
      for (const placement of placements) {
        if (placement.type === "ticket")
          addTicketHunk(placement.displayId, unit.hunk);
        else if (placement.type === "wrap")
          addWrapHunk(placement.stage, unit.hunk);
        else if (placement.type === "setup") setup.push(unit.hunk);
        else if (placement.type === "planning") planning.push(unit.hunk);
        else addUnattributed(unit.hunk);
      }
    }
  }

  const order = topoTicketIds(
    tickets.rows.map((ticket) => ticket.id),
    edges.rows.map((edge) => ({
      from: edge.from_ticket_id,
      to: edge.to_ticket_id,
    })),
  );
  const ticketById = new Map(tickets.rows.map((ticket) => [ticket.id, ticket]));
  const ordered = order
    .map((id) => ticketById.get(id))
    .filter(
      (ticket): ticket is (typeof tickets.rows)[number] => ticket != null,
    );

  const ticketSections: ReviewGuideTicket[] = [];
  const otherRepoTickets: ReviewGuideView["otherRepoTickets"] = [];
  for (const ticket of ordered) {
    const displayId = formatDisplayId("ticket", ticket.id);
    if (ticket.repo !== input.repo) {
      otherRepoTickets.push({
        displayId,
        title: ticket.title,
        repo: ticket.repo,
        pullRequestId: pullByRepo.get(ticket.repo_id) ?? null,
      });
      continue;
    }
    const hunks = ticketHunks.get(displayId) ?? [];
    if (hunks.length === 0) continue;
    const ticketRuns = runRows.filter((run) => run.ticketId === ticket.id);
    const decisions = ticketRuns.flatMap((run) =>
      TICKET_CODE_STAGES.has(run.stage) && run.result === "done"
        ? itemsFromRun({
            id: run.id,
            stage: run.stage,
            ticketId: run.ticketId,
            axis: run.axis,
            output: run.output,
          })
        : [],
    );
    const rulings = ticketRuns.flatMap((run) => {
      if (run.stage !== "review" && run.stage !== "final-review") return [];
      if (run.axis === "standards") return [];
      if (run.result !== "pass" && run.result !== "fix") return [];
      return rulingsOf(run.output);
    });
    const stories = (ticket.stories ?? [])
      .map((number) => storyText.get(number))
      .filter(
        (story): story is { number: number; text: string } => story != null,
      );
    ticketSections.push({
      id: ticket.id,
      displayId,
      title: ticket.title,
      appended: ticket.appended,
      stories,
      criteria:
        criteriaByTicket.get(displayId) ??
        (ticket.acceptance_criteria ?? []).map((text) => ({
          text,
          tests: [],
          status: "unverified",
          reason: null,
        })),
      summaries: summariesOf(ticketRuns, TICKET_CODE_STAGES),
      decisions,
      rulings,
      hunks,
      viewed: false,
    });
  }

  const wrapRuns = runRows.filter((run) => isWrapUpStage(run.stage));
  const wrapUp = WRAP_UP_STAGES.flatMap((stage) => {
    const summaries = summariesOf(
      wrapRuns.filter((run) => run.stage === stage),
      new Set([stage]),
    );
    const hunks = wrapHunks.get(stage) ?? [];
    if (summaries.length === 0 && hunks.length === 0) return [];
    return [{ stage, summaries, hunks, viewed: false }];
  });

  const unattributed = [...unattributedByPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hunks]) => ({ path, hunks }));
  const unattributedCount = unattributed.reduce(
    (sum, row) => sum + row.hunks.length,
    0,
  );

  return {
    revisionId: input.revisionId,
    unattributedCount,
    spec: {
      id: specRow.id,
      displayId: formatDisplayId("spec", specRow.id),
      title: specRow.title,
      type: specRow.type,
      userStories,
      sourceSpec:
        specRow.source_id != null && specRow.source_title != null
          ? {
              id: specRow.source_id,
              displayId: formatDisplayId("spec", specRow.source_id),
              title: specRow.source_title,
            }
          : null,
    },
    tickets: ticketSections,
    otherRepoTickets,
    wrapUp,
    changeRequests: [],
    setup,
    planning,
    unattributed,
  };
}

export async function reviewGuideOf(
  db: Pick<pg.Pool, "query">,
  revisionId: number,
): Promise<ReviewGuideView | undefined> {
  const revision = await db.query<{
    id: number;
    state: string;
    pull_request_id: number;
    spec_id: number;
    repo_id: number;
    repo: string;
    guide: unknown;
  }>(
    `SELECT r.id, r.state, r.pull_request_id, r.guide,
            p.spec_id, p.repo_id, repo.name AS repo
     FROM review_revisions r
     JOIN pull_requests p ON p.id = r.pull_request_id
     JOIN repos repo ON repo.id = p.repo_id
     WHERE r.id = $1`,
    [revisionId],
  );
  const row = revision.rows[0];
  if (row?.state !== "ready") return undefined;
  const viewedPaths = await viewedPathsOf(db, row.id, row.pull_request_id);
  if (row.guide && typeof row.guide === "object") {
    return overlayViewed(row.guide as ReviewGuideView, viewedPaths);
  }
  const assembled = await assembleGuide(db, {
    revisionId: row.id,
    specId: row.spec_id,
    repo: row.repo,
  });
  await db.query(
    `UPDATE review_revisions SET guide = $2::jsonb WHERE id = $1 AND guide IS NULL`,
    [row.id, JSON.stringify(assembled)],
  );
  return overlayViewed(assembled, viewedPaths);
}
