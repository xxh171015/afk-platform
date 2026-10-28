import { formatDisplayId } from "@afk/shared";

export interface TicketJobKeyParts {
  ticketId: number;
  contentVersion: number;
  stage: string;
  sequence: number;
}

// The idempotency key of a ticket job: (ticket, content version, stage, sequence), docs/specs/m1-platform.md
// 「作业队列」. Submitting the same tuple again returns the job that already exists.
export function ticketJobKey(parts: TicketJobKeyParts): string {
  const { contentVersion, stage, sequence } = parts;
  if (!Number.isInteger(contentVersion) || contentVersion < 1) {
    throw new RangeError(
      `content version must be a positive integer, got ${contentVersion}`,
    );
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(
      `sequence must be a positive integer, got ${sequence}`,
    );
  }
  if (stage === "" || stage.includes(":")) {
    throw new RangeError(
      `stage must be non-empty and contain no ":", got ${JSON.stringify(stage)}`,
    );
  }
  return `${ticketJobKeyPrefix(parts)}${sequence}`;
}

// Everything of the key before the sequence: all attempts of one stage of one ticket version share it.
export function ticketJobKeyPrefix(
  parts: Omit<TicketJobKeyParts, "sequence">,
): string {
  return `${formatDisplayId("ticket", parts.ticketId)}:${parts.contentVersion}:${parts.stage}:`;
}
