// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TokenExpiryBanner } from "./TokenExpiryBanner.tsx";
import { fakeServer, renderWithApp } from "./test-utils.tsx";

afterEach(cleanup);

describe("GitLab PAT expiry on the page", () => {
  it("warns when 30 days remain, and is silent when the token is farther out", async () => {
    renderWithApp(
      <TokenExpiryBanner />,
      fakeServer({
        "GET /hosts": () => ({
          json: {
            hosts: [
              {
                host: "gitlab.com",
                kind: "gitlab",
                workerId: "w1",
                reportedAt: "2026-11-09T00:00:00.000Z",
                tokenExpiresAt: "2026-12-09",
                daysLeft: 30,
              },
            ],
          },
        }),
      }),
    );
    expect(
      await screen.findByText(
        /gitlab.com 的 GitLab 个人令牌将在 2026-12-09 到期（还剩 30 天）/,
      ),
    ).toBeTruthy();

    cleanup();
    renderWithApp(
      <TokenExpiryBanner />,
      fakeServer({
        "GET /hosts": () => ({
          json: {
            hosts: [
              {
                host: "gitlab.com",
                kind: "gitlab",
                workerId: "w1",
                reportedAt: "2026-11-09T00:00:00.000Z",
                tokenExpiresAt: "2027-01-01",
                daysLeft: 53,
              },
            ],
          },
        }),
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
