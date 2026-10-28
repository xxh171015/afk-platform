// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchBox } from "./SearchBox.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

const result = {
  specs: [
    {
      id: 2,
      displayId: "S-2",
      title: "Refund bug",
      state: "running",
      matched: ["title"],
    },
  ],
  tickets: [
    {
      id: 7,
      displayId: "T-7",
      title: "Fix the refund rounding",
      state: "blocked",
      specId: 2,
      specDisplayId: "S-2",
      matched: ["title", "body"],
    },
    {
      id: 3,
      displayId: "T-3",
      title: "Refund email",
      state: "done",
      specId: 1,
      specDisplayId: "S-1",
      matched: ["body"],
    },
  ],
};

function searching(reply: unknown = result) {
  const asked: string[] = [];
  const fake = fakeServer({
    "GET /search": ({ url }) => {
      asked.push(url.searchParams.get("q") ?? "");
      return { json: reply };
    },
  });
  return { fake, asked };
}
const type = (text: string) =>
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search specs and tickets" }),
    { target: { value: text } },
  );

describe("the search box", () => {
  it("shows nothing until something is typed", () => {
    const { fake, asked } = searching();
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    expect(screen.queryByTestId("search-results")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("groups the results as specs and tickets, with where the text was found", async () => {
    const { fake } = searching();
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    type("refund");
    const panel = within(await screen.findByTestId("search-results"));
    await panel.findByText("Specs");
    expect(panel.getByText("Tickets")).toBeTruthy();
    expect(
      panel.getByRole("link", { name: "S-2 Refund bug" }).getAttribute("href"),
    ).toBe("#/specs/2");
    expect(
      panel
        .getByRole("link", { name: "T-7 Fix the refund rounding" })
        .getAttribute("href"),
    ).toBe("#/tickets/7");
    expect(
      panel
        .getByRole("link", { name: "T-3 Refund email" })
        .getAttribute("href"),
    ).toBe("#/tickets/3");
    expect(panel.getByText("in title")).toBeTruthy();
    expect(panel.getByText("of S-2, in title, body")).toBeTruthy();
    expect(panel.getByText("blocked")).toBeTruthy();
  });

  it("waits for the typing to pause: one request for a burst of keys", async () => {
    const { fake, asked } = searching();
    renderWithApp(<SearchBox debounceMs={40} />, fake);
    type("r");
    type("re");
    type("ref");
    await screen.findByTestId("search-results");
    await waitFor(() => expect(asked).toEqual(["ref"]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(asked).toEqual(["ref"]);
  });

  it("sends the text trimmed, and does not search for blanks", async () => {
    const { fake, asked } = searching();
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    type("   ");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("search-results")).toBeNull();
    type("  S-12 ");
    await waitFor(() => expect(asked).toEqual(["S-12"]));
  });

  it("says when nothing was found", async () => {
    const { fake } = searching({ specs: [], tickets: [] });
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    type("zzz");
    expect(await screen.findByText("Nothing found for “zzz”.")).toBeTruthy();
  });

  it("says what went wrong", async () => {
    const fake = fakeServer({
      "GET /search": () => ({
        status: 500,
        json: { error: "database is down" },
      }),
    });
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    type("x");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Search failed: database is down",
    );
  });

  it("closes and clears itself when a result is chosen", async () => {
    const { fake } = searching();
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    type("refund");
    fireEvent.click(
      await screen.findByRole("link", { name: "S-2 Refund bug" }),
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    await waitFor(() =>
      expect(screen.queryByTestId("search-results")).toBeNull(),
    );
  });

  it("closes on Escape and when the box is emptied", async () => {
    const { fake } = searching();
    renderWithApp(<SearchBox debounceMs={10} />, fake);
    type("refund");
    await screen.findByTestId("search-results");
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("search-results")).toBeNull(),
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");

    type("refund");
    await screen.findByTestId("search-results");
    type("");
    await waitFor(() =>
      expect(screen.queryByTestId("search-results")).toBeNull(),
    );
  });
});
