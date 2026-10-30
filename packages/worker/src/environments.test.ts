import { describe, expect, it } from "vitest";
import { EnvironmentLimiter } from "./environments.ts";

describe("EnvironmentLimiter", () => {
  it("lets the first environment start at once and holds the second until the first is released", async () => {
    const limiter = new EnvironmentLimiter();
    const order: string[] = [];
    const first = await limiter.acquire(1);
    const second = limiter.acquire(1).then((release) => {
      order.push("second started");
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    expect(limiter.active).toBe(1);
    first();
    (await second)();
    expect(order).toEqual(["second started"]);
    expect(limiter.active).toBe(0);
  });

  it("allows as many at once as the project says", async () => {
    const limiter = new EnvironmentLimiter();
    const releases = await Promise.all([
      limiter.acquire(2),
      limiter.acquire(2),
    ]);
    expect(limiter.active).toBe(2);
    for (const release of releases) release();
  });

  it("serves the waiting in the order they came, and releasing twice frees one place only", async () => {
    const limiter = new EnvironmentLimiter();
    const first = await limiter.acquire(1);
    const order: number[] = [];
    const waiting = [2, 3].map((n) =>
      limiter.acquire(1).then((release) => {
        order.push(n);
        return release;
      }),
    );
    first();
    first();
    const second = await (waiting[0] as Promise<() => void>);
    expect(limiter.active).toBe(1);
    second();
    (await (waiting[1] as Promise<() => void>))();
    expect(order).toEqual([2, 3]);
  });

  it("stops waiting for a place when the job is lost", async () => {
    const limiter = new EnvironmentLimiter();
    const held = await limiter.acquire(1);
    const lost = new AbortController();
    const waiting = limiter.acquire(1, lost.signal);
    lost.abort();
    await expect(waiting).rejects.toThrow(/lost/);
    held();
    expect(limiter.active).toBe(0);
  });
});
