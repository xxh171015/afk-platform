import { formatDisplayId } from "@afk/shared";
import type pg from "pg";
import { ensureIntegrationBranches } from "../planning/integration-branches.ts";
import { snapshotTicket } from "../tickets/versions.ts";

// What an integration ticket's failed e2e leads to: a fix ticket in the repo the diagnosis blames
// (docs/specs/m2-platform.md「联调」).

export interface Diagnosis {
  failingRepo: string;
  evidence: string;
  failingTests: string[];
}

// The integration ticket as the diagnosis and the fix ticket need it.
export interface IntegrationTicket {
  id: number;
  spec_id: number;
  title: string;
  acceptance_criteria: string[];
}

// The diagnosed problem as one line, for the acceptance criterion of the fix ticket.
const issueLine = (evidence: string) => {
  const first = evidence.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
};

export function fixTicketContent(
  ticket: IntegrationTicket,
  diagnosis: Diagnosis,
) {
  const shown = formatDisplayId("ticket", ticket.id);
  const lines = (items: string[]) =>
    items.map((item) => `- ${item}`).join("\n");
  return {
    title: `修复联调：${ticket.title}`,
    body: [
      `联调票 ${shown}（${ticket.title}）的 e2e 失败，诊断指出问题在 ${diagnosis.failingRepo}。`,
      "",
      "## 证据",
      "",
      diagnosis.evidence.trim(),
      "",
      "## 失败用例",
      "",
      diagnosis.failingTests.length
        ? lines(diagnosis.failingTests)
        : "（诊断没有列出）",
      "",
      `## 联调票 ${shown} 的验收标准`,
      "",
      lines(ticket.acceptance_criteria),
    ].join("\n"),
    acceptanceCriteria: [
      `联调票 ${shown} 的 e2e 通过`,
      `诊断指出的问题已修好：${issueLine(diagnosis.evidence)}`,
    ],
  };
}

// Makes the next fix ticket for the integration ticket, in front of it. They are numbered 1, 2, ... for as long as
// the integration ticket lives (a person re-running its e2e starts its rounds over, not this numbering), and the
// number is unique, so two diagnoses that race make one ticket. Returns undefined when the project has no repo of
// that name. The caller holds the spec lock.
export async function createFixTicket(
  client: pg.PoolClient,
  ticket: IntegrationTicket,
  diagnosis: Diagnosis,
): Promise<number | undefined> {
  const repo = await client.query<{ id: number }>(
    `SELECT r.id FROM repos r JOIN specs s ON s.project_id = r.project_id
     WHERE s.id = $1 AND r.name = $2`,
    [ticket.spec_id, diagnosis.failingRepo],
  );
  const repoId = repo.rows[0]?.id;
  if (repoId === undefined) return undefined;
  const content = fixTicketContent(ticket, diagnosis);
  const made = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM tickets WHERE fix_for_ticket_id = $1",
    [ticket.id],
  );
  const round = Number(made.rows[0]?.n) + 1;
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO tickets (spec_id, repo_id, type, title, body, acceptance_criteria, modules, fix_for_ticket_id, fix_round)
     VALUES ($1, $2, 'fix', $3, $4, $5, ARRAY['**'], $6, $7)
     ON CONFLICT (fix_for_ticket_id, fix_round) WHERE fix_for_ticket_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      ticket.spec_id,
      repoId,
      content.title,
      content.body,
      content.acceptanceCriteria,
      ticket.id,
      round,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) return undefined; // a diagnosis that raced this one made the ticket
  await snapshotTicket(client, id);
  await client.query(
    "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, $2, 'blocks')",
    [id, ticket.id],
  );
  await ensureIntegrationBranches(client, ticket.spec_id, [repoId]);
  return id;
}
