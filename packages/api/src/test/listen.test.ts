import net from "node:net";
import { afterAll, beforeAll, describe, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, testApp } from "./fake-worker.ts";

// afterEach of HTTP tests calls close() then drop(). A leftover socket must not hold that up
// (vitest hookTimeout is 20s; under load a stuck close made the next test fail too).

describe("the test API server", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
  }, 30_000);

  afterAll(async () => {
    await db.drop();
  });

  it("closes even if a client is still connected", {
    timeout: 3_000,
  }, async () => {
    const api = await listen(testApp({ pool: db.pool }));
    const port = Number(new URL(api.url).port);
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await api.close();
    socket.destroy();
  });
});
