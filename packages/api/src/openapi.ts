import type pg from "pg";
import { createApp } from "./app.ts";

// The routes only touch the pool when a request arrives, so describing them needs no database.
export function openApiDocument() {
  return createApp({
    pool: undefined as unknown as pg.Pool,
  }).getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "AFK platform API", version: "0.0.0" },
  });
}
