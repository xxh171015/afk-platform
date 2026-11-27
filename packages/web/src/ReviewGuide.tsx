import { DECISION_KIND_LABELS } from "@afk/shared";
import { specTypeLabel, stageLabel } from "./lib/labels.ts";
import { reviewHref } from "./review-search.ts";

type Guide = {
  unattributedCount: number;
  spec: {
    displayId: string;
    title: string;
    type: string;
    userStories: { number: number; text: string }[];
    sourceSpec: { displayId: string; title: string } | null;
  };
  tickets: {
    id: number;
    displayId: string;
    title: string;
    appended: boolean;
    stories: { number: number; text: string }[];
    criteria: {
      text: string;
      tests: string[];
      status: "verified" | "unverified";
      reason: string | null;
    }[];
    summaries: { run: string; stage: string; summary: string }[];
    decisions: {
      id: string;
      kind: string;
      text: string;
      ref?: string;
    }[];
    rulings: { id: string; verdict: string }[];
    hunks: {
      path: string;
      newStart: number;
      newLines: number;
      oldStart: number;
      oldLines: number;
    }[];
    viewed: boolean;
  }[];
  otherRepoTickets: {
    displayId: string;
    title: string;
    repo: string;
    pullRequestId: number | null;
  }[];
  wrapUp: {
    stage: string;
    summaries: { run: string; stage: string; summary: string }[];
    hunks: {
      path: string;
      newStart: number;
      newLines: number;
    }[];
    viewed: boolean;
  }[];
  changeRequests: {
    number: number;
    comments: { displayId: string; body: string }[];
    dispositions: { displayId: string; result: string }[];
    hunks: { path: string; newStart: number; newLines: number }[];
  }[];
  setup: { path: string; newStart: number; newLines: number }[];
  planning: { path: string; newStart: number; newLines: number }[];
  unattributed: {
    path: string;
    hunks: { path: string; newStart: number; newLines: number }[];
  }[];
};

type HunkJump = { path: string; newStart: number };

export function ReviewGuide({
  specId,
  guide,
  onJumpHunk,
}: {
  specId: number;
  guide: Guide;
  onJumpHunk: (hunk: HunkJump) => void;
}) {
  const typeLabel = specTypeLabel[guide.spec.type] ?? guide.spec.type;
  return (
    <div data-testid="review-guide" className="space-y-6 text-sm">
      {guide.unattributedCount > 0 ? (
        <p role="status" className="error">
          有 {guide.unattributedCount} 段改动没能对到票
        </p>
      ) : null}
      <section>
        <h2 className="text-sm font-medium">需求在做什么</h2>
        <p>
          {guide.spec.displayId} {guide.spec.title}
          {typeLabel ? ` · ${typeLabel}` : ""}
        </p>
        {guide.spec.sourceSpec ? (
          <p className="note">
            原需求 {guide.spec.sourceSpec.displayId}{" "}
            {guide.spec.sourceSpec.title}
          </p>
        ) : null}
        <h3 className="mt-2 text-xs font-medium text-muted-foreground">
          User Story
        </h3>
        <ul>
          {guide.spec.userStories.map((story) => (
            <li key={story.number}>
              {story.number}. {story.text}
            </li>
          ))}
        </ul>
      </section>
      {guide.tickets.map((ticket) => (
        <section key={ticket.id}>
          <h2 className="text-sm font-medium">
            {ticket.displayId} {ticket.title}
            {ticket.appended ? (
              <span className="badge appended"> 追加</span>
            ) : null}
            {ticket.viewed ? (
              <span className="ml-2 text-xs text-muted-foreground">已看完</span>
            ) : null}
          </h2>
          {ticket.stories.length > 0 ? (
            <ul className="note">
              {ticket.stories.map((story) => (
                <li key={story.number}>
                  User Story {story.number}. {story.text}
                </li>
              ))}
            </ul>
          ) : null}
          {ticket.criteria.length > 0 ? (
            <ul>
              {ticket.criteria.map((item) => (
                <li key={item.text}>
                  {item.status === "verified" ? "已验证" : "未验证"} {item.text}
                  {item.reason ? ` — ${item.reason}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {ticket.summaries.map((item) => (
            <p key={`${item.run}-${item.stage}`}>
              {item.run} {stageLabel[item.stage] ?? item.stage}：{item.summary}
            </p>
          ))}
          {ticket.decisions.map((item) => (
            <p key={item.id}>
              {DECISION_KIND_LABELS[
                item.kind as keyof typeof DECISION_KIND_LABELS
              ] ?? item.kind}{" "}
              {item.text}
              {item.ref ? ` (${item.ref})` : ""}
            </p>
          ))}
          {ticket.rulings.map((item) => (
            <p key={item.id}>
              Spec 轴 {item.id}：{item.verdict}
            </p>
          ))}
          <HunkList hunks={ticket.hunks} onJumpHunk={onJumpHunk} />
        </section>
      ))}
      {guide.otherRepoTickets.map((ticket) => (
        <p key={ticket.displayId} className="note">
          {ticket.pullRequestId != null ? (
            <a href={reviewHref(specId, { pr: ticket.pullRequestId })}>
              {ticket.displayId} 改的是 {ticket.repo}
            </a>
          ) : (
            `${ticket.displayId} 改的是 ${ticket.repo}`
          )}
        </p>
      ))}
      {guide.wrapUp.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">收尾</h2>
          {guide.wrapUp.map((section) => (
            <div key={section.stage} className="mt-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {stageLabel[section.stage] ?? section.stage}
                {section.viewed ? " · 已看完" : ""}
              </h3>
              {section.summaries.map((item) => (
                <p key={item.run}>
                  {item.run}：{item.summary}
                </p>
              ))}
              <HunkList hunks={section.hunks} onJumpHunk={onJumpHunk} />
            </div>
          ))}
        </section>
      ) : null}
      {guide.changeRequests.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">修改要求</h2>
          {guide.changeRequests.map((request) => (
            <div key={request.number} className="mt-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                修改要求 #{request.number}
              </h3>
              {request.comments.map((comment) => (
                <p key={comment.displayId}>
                  {comment.displayId}：{comment.body}
                </p>
              ))}
              {request.dispositions.map((item) => (
                <p key={item.displayId}>
                  {item.displayId}：{item.result}
                </p>
              ))}
              <HunkList hunks={request.hunks} onJumpHunk={onJumpHunk} />
            </div>
          ))}
        </section>
      ) : null}
      {guide.setup.length > 0 || guide.planning.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">设置和规划提交</h2>
          {guide.setup.length > 0 ? (
            <div className="mt-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                设置
              </h3>
              <HunkList hunks={guide.setup} onJumpHunk={onJumpHunk} />
            </div>
          ) : null}
          {guide.planning.length > 0 ? (
            <div className="mt-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                规划提交
              </h3>
              <HunkList hunks={guide.planning} onJumpHunk={onJumpHunk} />
            </div>
          ) : null}
        </section>
      ) : null}
      {guide.unattributed.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">没有归属的改动</h2>
          {guide.unattributed.map((file) => (
            <div key={file.path} className="mt-2">
              <p className="text-xs text-muted-foreground">{file.path}</p>
              <HunkList hunks={file.hunks} onJumpHunk={onJumpHunk} />
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function HunkList({
  hunks,
  onJumpHunk,
}: {
  hunks: { path: string; newStart: number; newLines: number }[];
  onJumpHunk: (hunk: HunkJump) => void;
}) {
  if (hunks.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {hunks.map((hunk) => (
        <li key={`${hunk.path}:${hunk.newStart}`}>
          <button
            type="button"
            aria-label={`跳到 ${hunk.path} +${hunk.newStart},${hunk.newLines}`}
            className="text-left text-xs text-primary underline"
            onClick={() =>
              onJumpHunk({ path: hunk.path, newStart: hunk.newStart })
            }
          >
            {hunk.path} +{hunk.newStart},{hunk.newLines}
          </button>
        </li>
      ))}
    </ul>
  );
}
