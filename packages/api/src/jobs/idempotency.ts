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

export interface FinalJobKeyParts {
  specId: number;
  repoId: number;
  step: string;
}

// The same for the spec-level steps of a finalization: one key per (spec, repo, step, sequence).
export function finalJobKeyPrefix(parts: FinalJobKeyParts): string {
  if (parts.step === "" || parts.step.includes(":")) {
    throw new RangeError(
      `step must be non-empty and contain no ":", got ${JSON.stringify(parts.step)}`,
    );
  }
  return `${formatDisplayId("spec", parts.specId)}:repo-${parts.repoId}:${parts.step}:`;
}

export function finalJobKey(
  parts: FinalJobKeyParts & { sequence: number },
): string {
  if (!Number.isInteger(parts.sequence) || parts.sequence < 1) {
    throw new RangeError(
      `sequence must be a positive integer, got ${parts.sequence}`,
    );
  }
  return `${finalJobKeyPrefix(parts)}${parts.sequence}`;
}
