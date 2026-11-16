// Runs two-axis review (or final-review) on docs/review-calibration samples with the
// same assembled review the worker uses. Needs Docker, the sandbox image, and a Cursor key.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runReviewCalibration } from "../packages/pipeline/src/review-calibration.ts";
import {
  SANDBOX_SKILLS_DIR,
  SandcastleAgentRunner,
} from "../packages/pipeline/src/sandcastle.ts";
import { loadConfig, parseEnvFile } from "../packages/worker/src/config.ts";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

const dir = flag("dir") ?? join(rootDir, "docs/review-calibration");
const specModel = flag("spec-model");
const standardsModel = flag("standards-model");

const readFile = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;
// The worker gets AFK_MODEL exported by scripts/up.sh; run by hand, fall back to ~/.afk/env.
const envFile = parseEnvFile(
  readFile(join(process.env.AFK_HOME || join(homedir(), ".afk"), "env")) ?? "",
);
const config = loadConfig({
  env: { AFK_MODEL: envFile.AFK_MODEL, ...process.env },
  homedir: homedir(),
  readFile,
});
const logDir = join(config.home, "calibration-logs");
mkdirSync(logDir, { recursive: true });

const markdown = await runReviewCalibration({
  root: dir,
  ...(specModel || standardsModel
    ? {
        models: {
          ...(specModel ? { spec: specModel } : {}),
          ...(standardsModel ? { standards: standardsModel } : {}),
        },
      }
    : {}),
  makeRunner: (repoDir) =>
    new SandcastleAgentRunner({
      cwd: repoDir,
      image: config.image,
      model: config.model,
      skillsMount: SANDBOX_SKILLS_DIR,
      cursorApiKey: config.cursorApiKey,
      logDir,
      limits: config.sandboxLimits,
    }),
});
process.stdout.write(markdown);
