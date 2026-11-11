import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_FILES, snapshotPath } from "@afk/shared/skills-snapshot";
import { build, type Plugin } from "esbuild";

// plat as one file that runs with node alone (GET /cli/plat.mjs): /afk-setup puts it on a planning machine that has
// no checkout of the platform. The three modules that read files from the disk get the files written into them.

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const at = (path: string) => join(root, path);

// Every file under `dir`, by its path relative to `dir`.
function filesUnder(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

const reader = (name: string, files: Record<string, string>, key: string) =>
  `const FILES = ${JSON.stringify(files)};
export const ${name} = (file) => {
  const text = FILES[${key}];
  if (text === undefined) throw new Error("plat does not carry " + ${key});
  return text;
};
`;

const inlineFiles: Plugin = {
  name: "inline-files",
  setup(builder) {
    const replaced: Record<string, () => string> = {
      [at("packages/shared/src/skills-snapshot-text.ts")]: () =>
        reader(
          "readRepoText",
          Object.fromEntries(
            SNAPSHOT_FILES.map((file) => {
              const path = snapshotPath(file);
              return [path, readFileSync(at(path), "utf8")];
            }),
          ),
          "file",
        ),
      [at("packages/cli/src/template-text.ts")]: () =>
        reader(
          "readTemplateText",
          filesUnder(at("packages/cli/templates")),
          'file + ".md"',
        ),
      [at("packages/cli/src/afk-setup-text.ts")]: () =>
        reader(
          "readAfkSetupSkill",
          { "SKILL.md": readFileSync(at("skills/afk-setup/SKILL.md"), "utf8") },
          '"SKILL.md"',
        ),
    };
    builder.onLoad({ filter: /-text\.ts$/ }, (args) => {
      const contents = replaced[args.path];
      return contents ? { contents: contents(), loader: "js" } : undefined;
    });
  },
};

let cached: Promise<string> | undefined;

// Built once per API process, on first ask.
export function cliBundle(): Promise<string> {
  cached ??= build({
    entryPoints: [at("packages/cli/src/bin.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    legalComments: "none",
    plugins: [inlineFiles],
    // so plat knows it is the file the platform handed out, which it may replace (packages/cli/src/self-update.ts)
    define: { __AFK_PLAT_BUNDLED__: "true" },
    // packages written as CommonJS call require(), which an ES module does not have
    banner: {
      js: 'import { createRequire as __afkCreateRequire } from "node:module"; const require = __afkCreateRequire(import.meta.url);',
    },
  })
    .then((result) => {
      const text = result.outputFiles[0]?.text;
      if (!text) throw new Error("esbuild wrote nothing");
      return text;
    })
    .catch((error) => {
      cached = undefined;
      throw error;
    });
  return cached;
}

// The sha256 of plat as the platform hands it out: GET /version names it, and plat sends its own with every call
// (PLAT_HEADER), so either side can tell an older plat.
let fingerprint: Promise<string> | undefined;
export function platFingerprint(): Promise<string> {
  fingerprint ??= cliBundle()
    .then((text) => createHash("sha256").update(text).digest("hex"))
    .catch((error) => {
      fingerprint = undefined;
      throw error;
    });
  return fingerprint;
}
