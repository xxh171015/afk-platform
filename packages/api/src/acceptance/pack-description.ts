import {
  decisionTally,
  formatDisplayId,
  HOST_KIND_LABELS,
  type HostKind,
  pullPhrase,
} from "@afk/shared";
import { pageUrl } from "../page-url.ts";
import type { AcceptancePack } from "./pack.ts";

// Markdown for one repo's pull request: merge order, that repo's section, integration (waived failures first),
// and a link to the spec. Other repos' criteria stay off this page
// (docs/specs/experience-platform.md「验收包进 PR」).

export function specDeliveryUrl(specId: number): string {
  return pageUrl(`/specs/${specId}/delivery`);
}

export function renderPackSection(
  pack: AcceptancePack,
  repo: string,
  specId: number,
): { section: string; summary: string } {
  const delivery = specDeliveryUrl(specId);
  const spec = formatDisplayId("spec", specId);
  const kind: HostKind = pack.hostKind ?? "github";
  const section = [
    needsDecisionLines(pack),
    planningDocsLines(pack, repo, kind),
    mergeOrderLines(pack),
    repoLines(pack, repo),
    integrationLines(pack, kind),
    `See ${spec} on the platform: ${delivery}`,
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
  const repoPack = pack.repos.find((item) => item.repo === repo);
  const criteria = repoPack?.tickets.flatMap((ticket) => ticket.criteria) ?? [];
  const unverified = criteria.filter((c) => c.status === "unverified").length;
  const verified = criteria.filter((c) => c.status === "verified").length;
  const summary = [
    `The acceptance pack for ${spec} ${repo} is too long for a ${HOST_KIND_LABELS[kind]} description.`,
    needsDecisionLines(pack),
    mergeOrderLines(pack),
    `Acceptance criteria: ${unverified} unverified, ${verified} verified.`,
    `See ${spec} on the platform: ${delivery}`,
  ].join("\n\n");
  return { section, summary };
}

// Only in the planning repo's pull request: that is where the planning docs are, or would have been.
function planningDocsLines(
  pack: AcceptancePack,
  repo: string,
  kind: HostKind,
): string {
  const docs = pack.planningDocs;
  if (!docs || docs.repo !== repo || docs.state === "unchanged") return "";
  const phrase = pullPhrase(kind);
  return docs.state === "waived"
    ? `## Planning docs\n\n**Left out**: the planning docs did not apply to the default branch and were given up, so this ${phrase} does not carry them.`
    : `## Planning docs\n\nThe first commit of this ${phrase} is the planning docs (glossary, ADRs) the spec was planned with, committed by the platform.`;
}

function needsDecisionLines(pack: AcceptancePack): string {
  const items = pack.needsDecision ?? [];
  if (items.length === 0) return "";
  const lines = ["## 合并前要你定的"];
  for (const item of items) {
    const ref = item.ref ? ` (${item.ref})` : "";
    const kind = item.kind === "deferred" ? "deferred" : "needs-human";
    lines.push(`- [${kind}] ${item.id} ${item.source}: ${item.text}${ref}`);
  }
  return lines.join("\n");
}

function mergeOrderLines(pack: AcceptancePack): string {
  const order = pack.mergeOrder;
  const line =
    order.ordered.length > 0
      ? order.ordered.join(" → ") +
        (order.unordered.length
          ? ` (no order: ${order.unordered.join(", ")})`
          : "")
      : "none (no contract relation between the repos)";
  return `## Merge order\n\n${line}`;
}

function repoLines(pack: AcceptancePack, repo: string): string {
  const section = pack.repos.find((item) => item.repo === repo);
  if (!section) return `## ${repo}\n\nNo section for this repo.`;
  const blocks = [
    `## ${repo}`,
    criteriaLines(section),
    findingsLines(section),
    standardsSourceLines(section),
    gateLines(section),
    flakyTestLines(section),
    decisionLines(section),
  ].filter(Boolean);
  return blocks.join("\n\n");
}

function criteriaLines(section: AcceptancePack["repos"][number]): string {
  if (section.tickets.length === 0) return "";
  const lines = ["### Acceptance criteria"];
  const write = (status: "unverified" | "verified") => {
    for (const ticket of section.tickets) {
      const criteria = ticket.criteria.filter((c) => c.status === status);
      if (criteria.length === 0) continue;
      lines.push(
        "",
        `**${ticket.displayId}** ${ticket.title}${ticket.appended ? " (appended)" : ""}`,
      );
      for (const criterion of criteria) {
        const mark = status === "verified" ? "x" : " ";
        const tests = criterion.tests.length
          ? ` (${criterion.tests.join(", ")})`
          : "";
        const reason = criterion.reason ? ` — ${criterion.reason}` : "";
        lines.push(`- [${mark}] ${criterion.text}${tests}${reason}`);
      }
    }
  };
  write("unverified");
  write("verified");
  return lines.join("\n");
}

function findingsLines(section: AcceptancePack["repos"][number]): string {
  if (section.findings.length === 0 && section.scopeCreep.length === 0)
    return "";
  const lines = ["### Findings"];
  for (const finding of section.findings) {
    lines.push(
      `- [${finding.resolution}] ${finding.ticket ?? "spec"} ${finding.stage}${finding.axis ? ` (${finding.axis})` : ""} ${finding.kind}: ${finding.body}`,
    );
  }
  for (const creep of section.scopeCreep) {
    lines.push(
      `- scope creep: ${creep.ticket ?? "spec"} ${creep.run}: ${creep.body}`,
    );
  }
  return lines.join("\n");
}

function standardsSourceLines(
  section: AcceptancePack["repos"][number],
): string {
  if (section.standardsSources.length === 0) return "";
  return [
    "### Standards sources",
    ...section.standardsSources.map((item) => {
      const who = item.ticket ?? "spec";
      return `- ${who} ${item.run} ${item.stage}: ${item.sources.join(", ")}`;
    }),
  ].join("\n");
}

function gateLines(section: AcceptancePack["repos"][number]): string {
  if (!section.gate) return "";
  const gate = section.gate;
  return [
    "### Gate",
    `${section.repo} @ ${gate.commitSha.slice(0, 7)}: ${gate.testsTotal ?? "?"} tests, ${gate.testsSkipped ?? "?"} skipped`,
  ].join("\n");
}

function flakyTestLines(section: AcceptancePack["repos"][number]): string {
  if (section.flakyTests.length === 0) return "";
  return [
    "### Unstable tests",
    "Failed the first run and passed when rerun on the same commit:",
    ...section.flakyTests.map((c) =>
      c.classname ? `- ${c.classname} ${c.name}` : `- ${c.name}`,
    ),
  ].join("\n");
}

function decisionLines(section: AcceptancePack["repos"][number]): string {
  const tally = decisionTally(section.decisions);
  if (tally.listed.length === 0 && tally.choice === 0 && tally.workaround === 0)
    return "";
  const lines = ["### Decisions"];
  for (const item of tally.listed) {
    const ref = item.ref ? ` (${item.ref})` : "";
    lines.push(
      `- [${item.kind}] ${item.source} ${item.run}: ${item.text}${ref}`,
    );
  }
  if (tally.choice > 0 || tally.workaround > 0) {
    lines.push(`- choice: ${tally.choice}, workaround: ${tally.workaround}`);
  }
  return lines.join("\n");
}

function integrationLines(pack: AcceptancePack, kind: HostKind): string {
  const integration = pack.integration;
  if (!integration) return "";
  const lines = ["## Integration"];
  if (integration.failedBeforePullRequest) {
    lines.push(
      "",
      `Opened although the e2e before the ${pullPhrase(kind)}s failed:`,
    );
    for (const ticket of integration.failedBeforePullRequest.tickets) {
      lines.push(
        `- ${ticket.displayId} ${ticket.title}: ${ticket.e2e.displayId} ${ticket.e2e.result ?? "?"}`,
      );
      if (ticket.diagnosis) {
        lines.push(
          `  diagnosis: ${ticket.diagnosis.failingRepo ?? "no repo"}: ${ticket.diagnosis.evidence}`,
        );
        if (ticket.diagnosis.failingTests.length)
          lines.push(`  failing: ${ticket.diagnosis.failingTests.join(", ")}`);
      }
    }
  }
  for (const ticket of integration.tickets) {
    lines.push(
      "",
      `**${ticket.displayId}** ${ticket.title} [${ticket.repo}] e2e ${ticket.result ?? "did not run"}`,
    );
  }
  return lines.join("\n");
}
