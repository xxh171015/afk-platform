// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { type TraceLink, TraceSection } from "./TraceSection.tsx";

afterEach(cleanup);

const sha = (ch: string) => ch.repeat(40);

function link(
  over: Partial<TraceLink> & Pick<TraceLink, "kind" | "sha">,
): TraceLink {
  return {
    repo: "afk-platform",
    ticketId: null,
    ticketDisplayId: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    ...over,
  };
}

function renderTrace(links: TraceLink[], titles: Array<[string, string]> = []) {
  return render(
    <TooltipProvider>
      <TraceSection
        links={links}
        repos={[
          {
            name: "afk-platform",
            url: "https://github.com/acme/afk-platform.git",
          },
        ]}
        ticketTitles={new Map(titles)}
      />
    </TooltipProvider>,
  );
}

describe("spec trace layout", () => {
  it("groups pull request numbers once at the section level", () => {
    renderTrace([
      link({
        kind: "ticket",
        sha: sha("a"),
        ticketId: 1,
        ticketDisplayId: "T-1",
      }),
      link({
        kind: "pr",
        sha: sha("b"),
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/acme/x/pull/12",
      }),
      link({
        kind: "ticket",
        sha: sha("c"),
        ticketId: 2,
        ticketDisplayId: "T-2",
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/acme/x/pull/12",
      }),
    ]);
    const trace = screen.getByTestId("spec-trace");
    expect(trace.textContent?.match(/#12/g)?.length).toBe(1);
    expect(trace.textContent).toContain("T-1");
  });

  it("names merged PR commits by ticket title instead of dumping every SHA", () => {
    const t58a = sha("1");
    const t58b = sha("2");
    const t58c = sha("3");
    renderTrace(
      [
        link({
          kind: "pr",
          sha: sha("m"),
          pullRequestNumber: 254,
          pullRequestUrl: "https://github.com/acme/afk-platform/pull/254",
        }),
        link({
          kind: "pr",
          sha: sha("s"),
          ticketId: 52,
          ticketDisplayId: "T-52",
          pullRequestNumber: 254,
          pullRequestUrl: "https://github.com/acme/afk-platform/pull/254",
        }),
        link({
          kind: "pr",
          sha: t58a,
          ticketId: 58,
          ticketDisplayId: "T-58",
          pullRequestNumber: 254,
          pullRequestUrl: "https://github.com/acme/afk-platform/pull/254",
        }),
        link({
          kind: "pr",
          sha: t58b,
          ticketId: 58,
          ticketDisplayId: "T-58",
          pullRequestNumber: 254,
          pullRequestUrl: "https://github.com/acme/afk-platform/pull/254",
        }),
        link({
          kind: "pr",
          sha: t58c,
          ticketId: 58,
          ticketDisplayId: "T-58",
          pullRequestNumber: 254,
          pullRequestUrl: "https://github.com/acme/afk-platform/pull/254",
        }),
      ],
      [
        ["T-52", "SSE 改由事件表喂"],
        ["T-58", "集成分支写入 Link"],
      ],
    );
    const trace = screen.getByTestId("spec-trace");
    expect(trace.textContent).toContain("1 个 PR");
    expect(trace.textContent).toContain("2 张票");
    expect(trace.textContent).toContain("SSE 改由事件表喂");
    expect(trace.textContent).toContain("集成分支写入 Link");
    expect(trace.textContent?.match(/#254/g)?.length).toBe(1);
    expect(trace.textContent).toContain("mmmmmmm");
    expect(trace.textContent).not.toContain("2222222");
    expect(trace.textContent).not.toContain("3333333");

    fireEvent.click(screen.getByRole("button", { name: /集成分支写入 Link/ }));
    expect(trace.textContent).toContain("2222222");
    expect(trace.textContent).toContain("3333333");
  });
});
