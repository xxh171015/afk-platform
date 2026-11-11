import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Notice } from "./notices.ts";

// The adapter the API process uses to put a notice on this Mac. osascript cannot open the URL when the
// banner is clicked; a failure (Focus, notifications off) is swallowed
// (docs/specs/experience-platform.md「通知」).

export interface NotificationMeta {
  eventId: number;
  projectId?: number;
}

export interface NotificationChannel {
  notify(notice: Notice, meta?: NotificationMeta): Promise<void>;
}

export function fanOutNotifications(
  channels: readonly NotificationChannel[],
): NotificationChannel {
  return {
    async notify(notice, meta) {
      await Promise.all(
        channels.map(async (channel) => {
          try {
            await channel.notify(notice, meta);
          } catch {
            // One channel's failure must not block the others (ADR 0009).
          }
        }),
      );
    },
  };
}

export const silentNotifications: NotificationChannel = {
  async notify() {},
};

export type RunCommand = (cmd: string, args: string[]) => Promise<unknown>;

const execFileAsync = promisify(execFile);

function appleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function macosNotifications(
  run: RunCommand = (cmd, args) => execFileAsync(cmd, args),
): NotificationChannel {
  return {
    async notify(notice) {
      const title = appleQuote(notice.title);
      const body = appleQuote(notice.body.replace(/\s*\n\s*/g, " — "));
      try {
        await run("osascript", [
          "-e",
          `display notification ${body} with title ${title}`,
        ]);
      } catch {
        // Focus or the system turned notifications off: the waiting queue is still the source of truth.
      }
    },
  };
}
