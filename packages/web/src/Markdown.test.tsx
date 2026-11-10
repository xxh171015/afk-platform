// @vitest-environment jsdom
import { SKILLS_SHA } from "@afk/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

afterEach(cleanup);

describe("Markdown", () => {
  it("hides HTML comments such as the overlay skills SHA marker", () => {
    render(
      <Markdown
        source={[
          `<!-- overlay for mattpocock/skills@${SKILLS_SHA} -->`,
          "",
          "你是一个 AFK 运行里的 agent。",
        ].join("\n")}
      />,
    );
    expect(screen.queryByText(/overlay for/)).toBeNull();
    expect(screen.getByText(/你是一个 AFK 运行里的 agent/)).toBeTruthy();
  });

  it("still shows an HTML comment inside a code fence", () => {
    render(<Markdown source={"```\n<!-- keep this -->\n```"} />);
    expect(screen.getByText(/keep this/)).toBeTruthy();
  });
});
