import type { AutoRetryOutcome } from "@afk/shared";
import type pg from "pg";

// A stage that timed out or gave no <result> runs again once on its own (stage-flow.ts, finalize-flow.ts). The next
// Run gets the platform's note through the usual Retry note path (copied into the Run when it is claimed, then
// cleared), and an event records the retry: no state changes, so no trigger writes one and no notice goes out.

// What went wrong, as the timeline and the note say it.
export const AUTO_RETRY_WHY: Record<AutoRetryOutcome, string> = {
  timeout: "超时",
  "invalid-output": "没有输出 <result>",
};

const NOTES: Record<AutoRetryOutcome, string> = {
  timeout:
    "平台自动重试：上一次 Run 超时，没有跑完。分支上已有的提交都保留着，先看已经做了什么，接着把剩下的做完，最后照常输出 <result>。",
  "invalid-output":
    "平台自动重试：上一次 Run 结束时没有输出能读的 <result>。分支上已有的提交都保留着，接着把事情做完，最后一条消息的末尾按这个阶段规定的格式输出 <result>…</result>。",
};

export type AutoRetryTarget =
  | { type: "ticket"; specId: number; repoId: number; ticketId: number }
  | {
      type: "finalization";
      specId: number;
      repoId: number;
      finalizationId: number;
    };

// Leaves the note for the next Run of the stage (the ticket's, or this repo's finalization's) and records the retry.
export async function applyAutoRetry(
  client: Pick<pg.PoolClient, "query">,
  target: AutoRetryTarget,
  stage: string,
  outcome: AutoRetryOutcome,
): Promise<void> {
  if (target.type === "ticket")
    await client.query("UPDATE tickets SET retry_note = $2 WHERE id = $1", [
      target.ticketId,
      NOTES[outcome],
    ]);
  else
    await client.query(
      "UPDATE finalizations SET retry_note = $2 WHERE id = $1",
      [target.finalizationId, NOTES[outcome]],
    );
  await client.query(
    `INSERT INTO events (spec_id, ticket_id, repo_id, type, reason, source, failure_source, data)
     VALUES ($1, $2, $3, $4, $5, 'scheduler', afk_failure_source($5, NULL), $6)`,
    [
      target.specId,
      target.type === "ticket" ? target.ticketId : null,
      target.repoId,
      target.type,
      outcome,
      JSON.stringify({ autoRetry: true, stage }),
    ],
  );
}
