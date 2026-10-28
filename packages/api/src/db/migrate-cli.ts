import { createPool } from "@afk/shared";
import { migrate } from "./migrate.ts";

const pool = createPool();
try {
  await migrate(pool);
  console.log("migrations applied");
} finally {
  await pool.end();
}
