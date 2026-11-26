import { describe, expect, it } from "vitest";
import {
  applyReviewRevisionLimits,
  chunkReviewRevisionResult,
  isLockfilePath,
  isTestPath,
  REVIEW_REVISION_LIMITS,
  type ReviewBlob,
  type ReviewFile,
  type ReviewRevisionResult,
  ReviewRevisionResultSchema,
} from "./review-revision.ts";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

describe("isTestPath", () => {
  it("recognises the documented test path heuristics", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.test.tsx")).toBe(true);
    expect(isTestPath("pkg/foo.spec.js")).toBe(true);
    expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
    expect(isTestPath("__tests__/foo.ts")).toBe(true);
    expect(isTestPath("src/tests/foo.ts")).toBe(true);
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
    expect(isTestPath("pkg/test_foo.py")).toBe(true);
  });

  it("does not treat nearby names as tests", () => {
    expect(isTestPath("src/foo.ts")).toBe(false);
    expect(isTestPath("attestations/foo.ts")).toBe(false);
    expect(isTestPath("src/testing/foo.ts")).toBe(false);
    expect(isTestPath("contest/foo.py")).toBe(false);
    expect(isTestPath("latest_test.txt")).toBe(false);
  });
});

describe("isLockfilePath", () => {
  it("recognises lockfile basenames, including under a directory", () => {
    expect(isLockfilePath("package-lock.json")).toBe(true);
    expect(isLockfilePath("pnpm-lock.yaml")).toBe(true);
    expect(isLockfilePath("yarn.lock")).toBe(true);
    expect(isLockfilePath("Cargo.lock")).toBe(true);
    expect(isLockfilePath("go.sum")).toBe(true);
    expect(isLockfilePath("poetry.lock")).toBe(true);
    expect(isLockfilePath("composer.lock")).toBe(true);
    expect(isLockfilePath("Gemfile.lock")).toBe(true);
    expect(isLockfilePath("apps/web/pnpm-lock.yaml")).toBe(true);
  });

  it("does not treat other names as lockfiles", () => {
    expect(isLockfilePath("package.json")).toBe(false);
    expect(isLockfilePath("lock.yaml")).toBe(false);
  });
});

const file = (over: Partial<ReviewFile> = {}): ReviewFile => ({
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  oldBlob: SHA,
  newBlob: SHA2,
  additions: 1,
  deletions: 0,
  binary: false,
  generated: false,
  test: false,
  lockfile: false,
  patch: "@@ -1 +1 @@\n-a\n+b\n",
  patchOmitted: null,
  sincePatch: null,
  attributions: [{ ticket: "T-1" }],
  hunks: [
    {
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      owners: [{ ticket: "T-1", lines: 1 }],
    },
  ],
  ...over,
});

describe("applyReviewRevisionLimits", () => {
  it("omits a patch larger than 256 KiB as too-large", () => {
    const patch = "x".repeat(REVIEW_REVISION_LIMITS.maxPatchBytesPerFile + 1);
    const limited = applyReviewRevisionLimits({
      files: [file({ patch })],
      blobs: [],
    });
    expect(limited.files[0]).toMatchObject({
      patch: null,
      patchOmitted: "too-large",
    });
    expect(limited.complete).toBe(true);
  });

  it("omits later patches as over-total once 4 MiB of patches are kept", () => {
    const perFile = "y".repeat(REVIEW_REVISION_LIMITS.maxPatchBytesPerFile);
    const files = Array.from({ length: 17 }, (_, i) =>
      file({ path: `f${i}.ts`, patch: perFile }),
    );
    const limited = applyReviewRevisionLimits({ files, blobs: [] });
    expect(limited.files[15]?.patchOmitted).toBeNull();
    expect(limited.files[16]).toMatchObject({
      patch: null,
      patchOmitted: "over-total",
    });
  });

  it("marks a binary file's patch omitted as binary", () => {
    const limited = applyReviewRevisionLimits({
      files: [file({ binary: true, patch: "Binary files differ\n" })],
      blobs: [],
    });
    expect(limited.files[0]).toMatchObject({
      patch: null,
      patchOmitted: "binary",
    });
  });

  it("keeps the first 3000 files and marks the revision incomplete", () => {
    const files = Array.from({ length: 3001 }, (_, i) =>
      file({ path: `f${i}.ts`, patch: `+${i}\n` }),
    );
    const limited = applyReviewRevisionLimits({ files, blobs: [] });
    expect(limited.files).toHaveLength(3000);
    expect(limited.complete).toBe(false);
    expect(limited.omittedReason).toBe("too-many-files");
  });

  it("drops hunks after the first 300 files", () => {
    const files = Array.from({ length: 301 }, (_, i) =>
      file({ path: `f${i}.ts` }),
    );
    const limited = applyReviewRevisionLimits({ files, blobs: [] });
    expect(limited.files[299]?.hunks).not.toBeNull();
    expect(limited.files[300]?.hunks).toBeNull();
  });

  it("keeps blobs until 16 MiB and skips one over 512 KiB", () => {
    const tooBig: ReviewBlob = {
      sha: "c".repeat(40),
      content: "z",
      bytes: REVIEW_REVISION_LIMITS.maxBlobBytes + 1,
    };
    const many: ReviewBlob[] = Array.from({ length: 33 }, (_, i) => ({
      sha: i.toString(16).padStart(40, "0"),
      content: "w",
      bytes: REVIEW_REVISION_LIMITS.maxBlobBytes,
    }));
    const limited = applyReviewRevisionLimits({
      files: [file()],
      blobs: [tooBig, ...many],
    });
    expect(limited.blobs.some((blob) => blob.sha === tooBig.sha)).toBe(false);
    expect(limited.blobs).toHaveLength(32);
  });
});

describe("ReviewRevisionResultSchema", () => {
  const valid = (): ReviewRevisionResult => ({
    stage: "review-revision",
    headSha: SHA,
    baseSha: SHA2,
    mergeBaseSha: SHA,
    complete: true,
    omittedReason: null,
    filesCount: 1,
    additions: 1,
    deletions: 0,
    files: [file()],
    blobs: [{ sha: SHA2, content: "b\n", bytes: 2 }],
    done: true,
  });

  it("accepts a result inside the limits", () => {
    expect(ReviewRevisionResultSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects a patch over 256 KiB", () => {
    const result = valid();
    result.files[0] = file({
      patch: "x".repeat(REVIEW_REVISION_LIMITS.maxPatchBytesPerFile + 1),
    });
    expect(ReviewRevisionResultSchema.safeParse(result).success).toBe(false);
  });

  it("rejects more than 3000 files", () => {
    const result = valid();
    result.files = Array.from({ length: 3001 }, (_, i) =>
      file({ path: `f${i}.ts` }),
    );
    result.filesCount = 3001;
    expect(ReviewRevisionResultSchema.safeParse(result).success).toBe(false);
  });
});

describe("chunkReviewRevisionResult", () => {
  it("splits by file when one complete would exceed the byte cap", () => {
    const big = "k".repeat(800);
    const result: ReviewRevisionResult = {
      stage: "review-revision",
      headSha: SHA,
      baseSha: SHA2,
      mergeBaseSha: SHA,
      complete: true,
      omittedReason: null,
      filesCount: 2,
      additions: 2,
      deletions: 0,
      files: [
        file({ path: "a.ts", patch: big, newBlob: SHA }),
        file({ path: "b.ts", patch: big, newBlob: SHA2 }),
      ],
      blobs: [
        { sha: SHA, content: "a\n", bytes: 2 },
        { sha: SHA2, content: "b\n", bytes: 2 },
      ],
      done: true,
    };
    const chunks = chunkReviewRevisionResult(result, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.done)).toEqual(
      chunks.map((_, i) => i === chunks.length - 1),
    );
    expect(
      chunks.flatMap((chunk) => chunk.files.map((item) => item.path)),
    ).toEqual(["a.ts", "b.ts"]);
    expect(chunks.every((chunk) => chunk.filesCount === 2)).toBe(true);
  });
});
