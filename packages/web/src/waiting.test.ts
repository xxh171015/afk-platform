import { describe, expect, it } from "vitest";
import { waitingReasonHint } from "./waiting.ts";

describe("waiting copy for a blocked reason", () => {
  it("tells a person to raise the sandbox memory for sandbox-oom", () => {
    expect(waitingReasonHint("sandbox-oom")).toBe("把沙箱内存调大后再试");
  });

  it("has no extra hint for other reasons", () => {
    expect(waitingReasonHint("job-failed")).toBeNull();
    expect(waitingReasonHint(null)).toBeNull();
  });
});
