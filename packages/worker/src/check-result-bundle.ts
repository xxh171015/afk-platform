import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Worker start: pack the result schemas into one file the agent sandbox can run with node alone.

export async function writeCheckResultBundle(outfile: string): Promise<void> {
  mkdirSync(dirname(outfile), { recursive: true });
  const entry = fileURLToPath(
    new URL("../../pipeline/src/check-result.ts", import.meta.url),
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    write: true,
    legalComments: "none",
  });
}
