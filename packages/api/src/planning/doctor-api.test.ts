import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { listen, type RunningApi, testApp } from "../test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const skillsFail = {
  id: "skills",
  title: "skills",
  status: "fail" as const,
  detail: "the to-spec skill was not found",
  command: "npx skills@latest add xxh171015/afk-platform",
};

describe("PUT/GET /projects/{id}/doctor-report", () => {
  it("keeps the last report per machine and GET returns the newest across machines", async () => {
    const project = await call("POST", "/projects", { name: "shop" });
    const id = project.body.id as number;
    expect((await call("GET", `/projects/${id}/doctor-report`)).body).toEqual({
      report: null,
    });

    const first = await call("PUT", `/projects/${id}/doctor-report`, {
      machine: "dev-mac",
      items: [skillsFail],
    });
    expect(first.status).toBe(200);
    expect(first.body.machine).toBe("dev-mac");
    expect(first.body.items).toEqual([skillsFail]);
    expect(typeof first.body.checkedAt).toBe("string");

    const got = await call("GET", `/projects/${id}/doctor-report`);
    expect(got.status).toBe(200);
    expect(got.body.report).toEqual(first.body);

    const later = await call("PUT", `/projects/${id}/doctor-report`, {
      machine: "laptop",
      items: [{ id: "plat", title: "plat", status: "ok" }],
    });
    expect(later.status).toBe(200);
    const newest = await call("GET", `/projects/${id}/doctor-report`);
    expect(newest.body.report.machine).toBe("laptop");

    const again = await call("PUT", `/projects/${id}/doctor-report`, {
      machine: "dev-mac",
      items: [{ id: "skills", title: "skills", status: "ok" }],
    });
    expect(again.status).toBe(200);
    const after = await call("GET", `/projects/${id}/doctor-report`);
    expect(after.body.report.machine).toBe("dev-mac");
    expect(after.body.report.items[0].status).toBe("ok");
    const rows = await db.pool.query(
      "SELECT machine FROM doctor_reports WHERE project_id = $1 ORDER BY machine",
      [id],
    );
    expect(rows.rows.map((r) => r.machine)).toEqual(["dev-mac", "laptop"]);
  });

  it("404s when the project does not exist", async () => {
    expect((await call("GET", "/projects/9/doctor-report")).status).toBe(404);
    expect(
      (
        await call("PUT", "/projects/9/doctor-report", {
          machine: "dev-mac",
          items: [],
        })
      ).status,
    ).toBe(404);
  });
});
