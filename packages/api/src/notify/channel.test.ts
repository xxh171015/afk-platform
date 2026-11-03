import { describe, expect, it } from "vitest";
import { macosNotifications } from "./channel.ts";

describe("macosNotifications", () => {
  it("asks osascript to display the title and body, and never throws when that fails", async () => {
    const calls: string[][] = [];
    const channel = macosNotifications(async (cmd, args) => {
      calls.push([cmd, ...args]);
    });
    await channel.notify({
      title: "票卡住",
      body: "T-7 写 CSV：门禁失败\nhttp://127.0.0.1:5173/tickets/7",
    });
    expect(calls).toEqual([
      [
        "osascript",
        "-e",
        'display notification "T-7 写 CSV：门禁失败 — http://127.0.0.1:5173/tickets/7" with title "票卡住"',
      ],
    ]);

    const failing = macosNotifications(async () => {
      throw new Error("not allowed");
    });
    await expect(
      failing.notify({
        title: "待处理",
        body: "S-1 x：PR 被关\nhttp://x/waiting",
      }),
    ).resolves.toBeUndefined();
  });

  it("escapes quotes in the AppleScript strings", async () => {
    const calls: string[][] = [];
    await macosNotifications(async (_cmd, args) => {
      calls.push(args);
    }).notify({
      title: 'say "hi"',
      body: 'body "x"',
    });
    expect(calls[0]?.[1]).toBe(
      'display notification "body \\"x\\"" with title "say \\"hi\\""',
    );
  });
});
