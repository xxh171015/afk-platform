import { autoMergeLine, type HostKind } from "@afk/shared";
import { ExternalLink } from "lucide-react";
import { FinalizeProgress, UpdateBranchRuns } from "../FinalizeProgress.tsx";
import { pullAbbrev } from "../host-copy.ts";
import { prCiLabel, prReviewLabel } from "../lib/labels.ts";
import { StatusBadge } from "../StatusBadge.tsx";
import { AcceptancePackMeta, PackRepoSection } from "./pack.tsx";
import { list, type SpecView } from "./view.ts";

// The "交付" tab: finalizations, pull requests, then the acceptance pack as its own chapter.
export function Delivery({
  pullRequests,
  orderBroken,
  mergeOrder,
  acceptancePack,
  finalizations,
  finalRuns,
  repos: specRepos,
  hostKind,
  autoMerge,
  specState,
}: Pick<
  SpecView,
  | "pullRequests"
  | "orderBroken"
  | "mergeOrder"
  | "acceptancePack"
  | "finalizations"
  | "finalRuns"
  | "autoMerge"
> & {
  repos: NonNullable<SpecView["spec"]["repos"]>;
  hostKind: HostKind;
  specState: SpecView["spec"]["state"];
}) {
  const repoUrls = new Map(
    list(specRepos).map((repo) => [repo.name, repo.url]),
  );
  const prs = list(pullRequests);
  const steps = list(finalizations);
  const runs = list(finalRuns);
  const updateRuns = runs.filter((run) => run.stage === "update-branch");
  const finishRuns = runs.filter((run) => run.stage !== "update-branch");
  const hasFinalize = steps.length > 0 || finishRuns.length > 0;
  const hasUpdate = updateRuns.length > 0;
  const hasPrs = prs.length > 0;
  const nothing = !hasFinalize && !hasUpdate && !hasPrs && !acceptancePack;
  const mergeLine = autoMergeLine(autoMerge, specState);
  const prRepos = [
    ...list(mergeOrder?.ordered),
    ...prs.map((pr) => pr.repo),
  ].filter((name, index, all) => all.indexOf(name) === index);

  return (
    <>
      {mergeLine ? (
        <p className="note mb-4" data-testid="auto-merge">
          {mergeLine}
        </p>
      ) : null}
      {nothing ? <p className="note">还没有可交付的内容</p> : null}
      {list(orderBroken).map((b) => (
        <p key={b.repo} className="error" data-testid="order-broken">
          合并顺序被打破：{b.repo} 合在了 {b.skipped.join("、")} 前面。
        </p>
      ))}
      {hasUpdate ? (
        <section id="delivery-update-branch" className="mb-8 scroll-mt-6">
          <h2 className="mb-3 text-sm font-semibold">合 main</h2>
          <UpdateBranchRuns runs={updateRuns} />
        </section>
      ) : null}
      {hasFinalize ? (
        <section id="delivery-finalize" className="mb-8 scroll-mt-6">
          <h2 className="mb-3 text-sm font-semibold">收尾</h2>
          <FinalizeProgress steps={steps} runs={finishRuns} />
        </section>
      ) : null}
      {hasPrs ? (
        <section id="delivery-prs" className="mb-8 scroll-mt-6">
          <h2 className="mb-1 text-sm font-semibold">{pullAbbrev(hostKind)}</h2>
          <p className="note mb-3">
            按这个顺序合并；平台从不合入。
            {list(mergeOrder?.ordered).length > 0
              ? ` 合并顺序：${list(mergeOrder?.ordered).join(" → ")}`
              : " 没有合并顺序（没有契约关系）。"}
            {list(mergeOrder?.unordered).length > 0
              ? ` 没有顺序：${list(mergeOrder?.unordered).join("、")}`
              : ""}
          </p>
          {prRepos.map((repo) => {
            const pr = prs.find((item) => item.repo === repo);
            if (!pr) return null;
            return (
              <div key={repo} className="mb-3 rounded-md border bg-card p-4">
                <h3 className="mb-2 text-sm font-medium">{repo}</h3>
                <ul className="pull-requests">
                  <li>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      {pr.repo} #{pr.number}
                      <ExternalLink className="ml-1 inline size-3" />
                    </a>{" "}
                    <StatusBadge kind="pr" code={pr.state} />
                    {pr.draft ? " (草稿)" : ""}{" "}
                    {list(pr.waitsFor).length > 0 ? (
                      <span className="note">
                        排在 {list(pr.waitsFor).join("、")} 后面
                        {" · "}
                      </span>
                    ) : null}
                    {prCiLabel[pr.ci] ?? pr.ci}，
                    {prReviewLabel[pr.review] ?? pr.review}
                    {pr.syncError ? (
                      <span className="error"> 读取失败：{pr.syncError}</span>
                    ) : null}
                  </li>
                </ul>
              </div>
            );
          })}
        </section>
      ) : null}
      <section id="delivery-pack" className="mb-4 scroll-mt-6">
        <h2 className="mb-3 text-sm font-semibold">验收包</h2>
        {acceptancePack ? (
          <>
            <AcceptancePackMeta pack={acceptancePack} />
            {list(acceptancePack.repos).map((item) => (
              <PackRepoSection
                key={item.repo}
                repo={item}
                repoUrl={repoUrls.get(item.repo)}
              />
            ))}
          </>
        ) : (
          <p className="note">
            还没有验收包。开完 {pullAbbrev(hostKind)} 后会生成。
          </p>
        )}
      </section>
    </>
  );
}
