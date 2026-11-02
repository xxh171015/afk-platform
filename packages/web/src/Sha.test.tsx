// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { Sha } from "./Sha.tsx";

afterEach(cleanup);

describe("Sha", () => {
  it("shows the first seven characters and copies the full value", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <TooltipProvider>
        <Sha value="abcdef1234567890abcdef1234567890abcdef12" />
      </TooltipProvider>,
    );
    const button = screen.getByRole("button", {
      name: "abcdef1",
    });
    expect(button.getAttribute("title")).toBe(
      "abcdef1234567890abcdef1234567890abcdef12",
    );
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(
      "abcdef1234567890abcdef1234567890abcdef12",
    );
  });
});
