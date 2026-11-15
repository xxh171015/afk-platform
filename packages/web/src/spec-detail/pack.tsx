import {
  DECISION_KIND_LABELS,
  type DecisionKind,
  decisionTally,
} from "@afk/shared";
import { ShaChip } from "../components/afk/badges.tsx";
import { hostKindOf, pullAbbrev } from "../host-copy.ts";
import { commitHtmlUrl } from "../host-links.ts";
import { list, type SpecView } from "./view.ts";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

type PackRepo = NonNullable<SpecView["acceptancePack"]>["repos"][number];
type PackDecision = {
  source: string;
  run: string;
  kind: string;
  text: string;
  ref?: string;
};

function PackDecisions({ repo }: { repo: PackRepo }) {
  const tally = decisionTally(
    list((repo as PackRepo & { decisions?: PackDecision[] }).decisions),
  );
  if (tally.listed.length === 0 && tally.choice === 0 && tally.workaround === 0)
    return null;
  const countedSummary = [
    tally.choice > 0 ? `小事 ${tally.choice} 条` : null,
    tally.workaround > 0 ? `绕过 ${tally.workaround} 条` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("，");
  const line = (item: PackDecision) => {
    const kind = DECISION_KIND_LABELS[item.kind as DecisionKind] ?? item.kind;
    const ref = item.ref ? ` (${item.ref})` : "";
    return `${kind} ${item.source} ${item.run}: ${item.text}${ref}`;
  };
  return (
    <>
      <p className="note">决定：</p>
      {tally.listed.length > 0 ? (
        <ul className="decisions">
          {tally.listed.map((item) => (
            <li key={`${item.run}-${item.kind}-${item.text}`}>{line(item)}</li>
          ))}
        </ul>
      ) : null}
      {countedSummary ? (
        <details className="afk-disclosure mt-2 text-sm">
          <summary>{countedSummary}</summary>
          <ul className="decisions-counted mt-1">
            {tally.counted.map((item) => (
              <li key={`${item.run}-${item.kind}-${item.text}`}>
                {line(item)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

export function PackRepoSection({
  repo,
  repoUrl,
}: {
  repo: PackRepo;
  repoUrl?: string | null;
}) {
  return (
    <section
      className="pack-repo mt-3 rounded-md border bg-card p-4"
      data-testid={`pack-repo-${repo.repo}`}
    >
      <h3 className="mb-3 text-sm font-semibold">{repo.repo}</h3>
      <h4 className="text-xs font-medium text-muted-foreground">验收标准</h4>
      {list(repo.tickets).map((ticket) => (
        <div key={ticket.displayId} className="mt-2">
          <p>
            <strong>{ticket.displayId}</strong> {ticket.title}
            {ticket.appended ? (
              <span className="badge appended"> 追加</span>
            ) : null}
          </p>
          <ul className="criteria mt-1 space-y-2">
            {list(ticket.criteria).map((criterion) => (
              <li key={criterion.text} data-status={criterion.status}>
                <span className={`badge criterion-${criterion.status}`}>
                  {criterion.status}
                </span>{" "}
                {criterion.text}
                {criterion.reason ? (
                  <span className="note"> — {criterion.reason}</span>
                ) : null}
                {list(criterion.tests).length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                    {list(criterion.tests).map((test) => (
                      <li key={test}>{test}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {list(repo.findings).length > 0 ? (
        <ul className="pack-findings">
          {list(repo.findings).map((finding) => (
            <li key={`${finding.run}-${finding.kind}-${finding.body}`}>
              <span className="badge">{finding.resolution}</span>{" "}
              {finding.axis ? (
                <span className={`badge axis-${finding.axis}`}>
                  {finding.axis}
                </span>
              ) : null}{" "}
              {finding.ticket ?? "spec"} {finding.stage} {finding.kind}:{" "}
              {finding.body}
            </li>
          ))}
        </ul>
      ) : null}
      {list(repo.standardsSources).length > 0 ? (
        <>
          <p className="note">Standards 依据：</p>
          <ul className="standards-sources">
            {list(repo.standardsSources).map((item) => (
              <li key={`${item.run}-${item.stage}`}>
                {item.ticket ?? "spec"} {item.run} {item.stage}:{" "}
                {item.sources.join(", ")}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {list(repo.scopeCreep).length > 0 ? (
        <>
          <p className="note">范围蔓延：票没要求的改动</p>
          <ul className="scope-creep">
            {list(repo.scopeCreep).map((item) => (
              <li key={`${item.run}-${item.body}`}>
                {item.ticket ?? "spec"} {item.run}: {item.body}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <PackDecisions repo={repo} />
      {repo.gate ? (
        <p className="gates">
          门禁：{" "}
          <ShaChip
            sha={repo.gate.commitSha}
            href={repoUrl ? commitHtmlUrl(repoUrl, repo.gate.commitSha) : null}
          />
          : {repo.gate.testsTotal ?? "?"} 个测试，跳过{" "}
          {repo.gate.testsSkipped ?? "?"} 个，{seconds(repo.gate.durationMs)} (
          {list(repo.gate.steps)
            .map(
              (step) =>
                `${step.name} ${seconds(step.ms)}${step.exitCode === 0 ? "" : ` exit ${step.exitCode}`}`,
            )
            .join(", ")}
          )
        </p>
      ) : null}
      {list(repo.flakyTests).length > 0 ? (
        <>
          <p className="note">重跑通过的不稳定测试：</p>
          <ul className="flaky-tests">
            {list(repo.flakyTests).map((c) => (
              <li key={`${c.classname}-${c.name}`}>
                {c.classname ? `${c.classname} ${c.name}` : c.name}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {list(repo.protectedPathApprovals).length > 0 ? (
        <ul className="approvals">
          {list(repo.protectedPathApprovals).map((approval) => (
            <li key={approval.ticket}>
              已批准的保护路径，{approval.ticket}： {approval.paths.join(", ")}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// Merge order, cancelled tickets, agent time: the bits that are not per-repo.
export function AcceptancePackMeta({
  pack,
}: {
  pack: NonNullable<SpecView["acceptancePack"]>;
}) {
  const needsDecision = list(
    (
      pack as {
        needsDecision?: {
          kind: string;
          id: string;
          source: string;
          text: string;
          ref?: string;
        }[];
      }
    ).needsDecision,
  );
  return (
    <>
      {needsDecision.length > 0 ? (
        <section className="mb-4" data-testid="pack-needs-decision">
          <h4>合并前要你定的</h4>
          <ul>
            {needsDecision.map((item) => (
              <li key={item.id}>
                [{item.kind}] {item.id} {item.source}: {item.text}
                {item.ref ? ` (${item.ref})` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {list(pack.orderBroken).map((b) => (
        <p key={b.repo} className="error">
          合并顺序被打破：{b.repo} 合在了 {b.skipped.join("、")} 前面。
        </p>
      ))}
      <p className="note" data-testid="pack-merge-order">
        {list(pack.mergeOrder?.ordered).length > 0
          ? `合并顺序：${list(pack.mergeOrder?.ordered).join(" → ")}${
              list(pack.mergeOrder?.unordered).length > 0
                ? `（没有顺序：${list(pack.mergeOrder?.unordered).join("、")}）`
                : ""
            }`
          : "没有合并顺序：这些仓库没有契约关系。"}
      </p>

      {list(pack.cancelledTickets).length > 0 ? (
        <>
          <h4>已取消的票</h4>
          <ul className="cancelled-tickets">
            {list(pack.cancelledTickets).map((ticket) => (
              <li key={ticket.displayId}>
                <strong>{ticket.displayId}</strong> {ticket.title} [
                {ticket.repo}] <span className="badge">已取消</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pack.agentSeconds != null ? (
        <p className="note">Agent 耗时：{pack.agentSeconds} s。</p>
      ) : null}
      {pack.integration ? (
        <section className="mt-4" data-testid="pack-integration">
          <h4>联调</h4>
          {pack.integration.failedBeforePullRequest ? (
            <p className="error">
              开 {pullAbbrev(hostKindOf(pack))} 前联调失败
            </p>
          ) : null}
          <ul>
            {list(pack.integration.tickets).map((ticket) => (
              <li key={ticket.displayId}>
                <strong>{ticket.displayId}</strong> {ticket.title}
                {ticket.result ? ` · ${ticket.result}` : ""}
                {ticket.testsTotal != null
                  ? ` · ${ticket.testsTotal} 个测试，失败 ${ticket.testsFailed ?? 0} 个`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
