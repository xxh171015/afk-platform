import { readFileSync } from "node:fs";
import { RESULT_CHECK_STAGES, resultCheckSchema } from "./agent.ts";

// `node /home/agent/afk/check-result.mjs <stage> <result-file> [--no-normalize]`
// Bundled at worker start so the sandbox can run it without the platform's packages.

const argv = process.argv.slice(2);
const normalize = !argv.includes("--no-normalize");
const positional = argv.filter((arg) => arg !== "--no-normalize");
const [stage, file] = positional;

if (!stage || !file) {
  console.error(
    "usage: node /home/agent/afk/check-result.mjs <stage> <result-file>",
  );
  process.exit(1);
}

const schema = resultCheckSchema(stage, { normalize });
if (!schema) {
  console.error(`unknown stage: ${stage}`);
  console.error(`available: ${RESULT_CHECK_STAGES.join(", ")}`);
  process.exit(1);
}

let data: unknown;
try {
  data = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`(root)：${message}`);
  process.exit(1);
}

const parsed = schema.safeParse(data);
if (parsed.success) process.exit(0);

for (const issue of parsed.error.issues) {
  const path =
    issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
  console.error(`${path}：${issue.message}`);
}
process.exit(1);
