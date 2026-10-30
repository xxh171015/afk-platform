// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const server = () =>
  fakeServer({
    "GET /specs": () => ({
      json: {
        specs: [
          {
            id: 3,
            displayId: "S-3",
            slug: "s",
            title: "Third",
            type: "feature",
            state: "running",
            pauseReason: null,
            project: "shop",
            progress: {
              total: 1,
              done: 0,
              active: 1,
              blocked: 0,
              pending: 0,
              cancelled: 0,
            },
          },
        ],
      },
    }),
    "GET /specs/3": () => ({
      json: {
        spec: {
          id: 3,
          displayId: "S-3",
          slug: "s",
          title: "Third",
          type: "feature",
          body: "",
          state: "running",
          pauseReason: null,
          integrationBranches: [],
          warnings: [],
        },
        tickets: [
          {
            id: 9,
            displayId: "T-9",
            specId: 3,
            specDisplayId: "S-3",
            title: "Only ticket",
            type: "implementation",
            state: "running",
            blockedReason: null,
            repo: "backend",
            brief: null,
          },
        ],
        edges: [],
        finalizations: [],
        pullRequests: [],
        cleanups: [],
        readyFailures: [],
        acceptancePack: null,
      },
    }),
  });

describe("the app", () => {
  it("starts on the list of specs", async () => {
    renderWithApp(<App />, server());
    expect(await screen.findByRole("link", { name: "S-3" })).toBeTruthy();
  });

  it("shows a spec's page for #/specs/<id>, and goes back to the list", async () => {
    window.location.hash = "#/specs/3";
    renderWithApp(<App />, server());
    expect(await screen.findByTestId("node-T-9")).toBeTruthy();
    window.location.hash = "#/";
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "S-3" })).toBeTruthy(),
    );
  });

  it("shows a ticket's page for #/tickets/<id>", async () => {
    window.location.hash = "#/tickets/9";
    const base = server();
    const withTicket = fakeServer({
      "GET /tickets/9": () => ({
        json: {
          ticket: {
            id: 9,
            displayId: "T-9",
            specId: 3,
            specDisplayId: "S-3",
            title: "Only ticket",
            type: "implementation",
            state: "done",
            blockedReason: null,
            repo: "backend",
            brief: null,
            body: "",
            acceptanceCriteria: ["works"],
            modules: [],
            allowedProtectedPaths: [],
            contentVersion: 1,
            contractSha: null,
            fixCounts: {},
            reviewed: false,
          },
          versions: [{ version: 1, createdAt: "2026-10-28T09:00:00.000Z" }],
          upstream: [],
          downstream: [],
          runs: [],
          findings: [],
          gateResults: [],
        },
      }),
    });
    void base;
    renderWithApp(<App />, withTicket);
    expect(
      (await screen.findByRole("heading", { level: 2 })).textContent,
    ).toContain("T-9 Only ticket");
  });

  it("shows the queue of what waits for you at #/blocked, and counts it in the menu", async () => {
    window.location.hash = "#/blocked";
    const fake = fakeServer({
      "GET /blocked": () => ({
        json: {
          tickets: [
            {
              id: 1,
              displayId: "T-1",
              specId: 3,
              specDisplayId: "S-3",
              title: "Stuck",
              type: "implementation",
              state: "blocked",
              blockedReason: "agent-gave-up",
              repo: "backend",
              brief: null,
            },
          ],
          finalizations: [],
          pullRequests: [],
          cleanups: [],
          readyFailures: [],
          specs: [
            { id: 3, displayId: "S-3", title: "Third", reason: "paused" },
          ],
        },
      }),
    });
    renderWithApp(<App />, fake);
    expect(await screen.findByTestId("blocked-T-1")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Waiting for you (2)" })
        .getAttribute("href"),
    ).toBe("#/blocked");
    expect(
      screen.getByRole("link", { name: "Specs" }).getAttribute("href"),
    ).toBe("#/");
  });

  it("does not show a count in the menu when nothing waits", async () => {
    renderWithApp(
      <App />,
      fakeServer({
        "GET /specs": () => ({ json: { specs: [] } }),
        "GET /blocked": () => ({
          json: {
            tickets: [],
            finalizations: [],
            pullRequests: [],
            cleanups: [],
            readyFailures: [],
            specs: [],
          },
        }),
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Waiting for you" }),
    ).toBeTruthy();
  });

  it("has the search box at the top of every page", async () => {
    window.location.hash = "#/specs/3";
    renderWithApp(<App />, server());
    expect(
      await screen.findByRole("searchbox", {
        name: "Search specs and tickets",
      }),
    ).toBeTruthy();
    window.location.hash = "#/blocked";
    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", { name: "Search specs and tickets" }),
      ).toBeTruthy(),
    );
  });

  it("falls back to the list for an address it does not know", async () => {
    window.location.hash = "#/specs/not-a-number";
    renderWithApp(<App />, server());
    expect(await screen.findByRole("link", { name: "S-3" })).toBeTruthy();
  });
});
