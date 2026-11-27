import { z } from "zod";

// Caps on one Review revision (docs/specs/in-platform-review.md §3). The complete payload schema
// validates against these; the worker omits patches and blob bodies that would exceed them.
export const REVIEW_REVISION_LIMITS = {
  maxPatchBytesPerFile: 256 * 1024,
  maxPatchBytesTotal: 4 * 1024 * 1024,
  maxFiles: 3000,
  maxLineBlameFiles: 300,
  maxBlobBytes: 512 * 1024,
  maxBlobBytesTotal: 16 * 1024 * 1024,
} as const;

// One complete call's JSON should stay under this; the worker splits by file when the full result is larger.
export const MAX_REVIEW_REVISION_COMPLETE_BYTES = 1024 * 1024;

export const REVIEW_REVISION_STATES = ["pending", "ready", "failed"] as const;
export type ReviewRevisionState = (typeof REVIEW_REVISION_STATES)[number];

export const REVIEW_FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "mode",
] as const;
export type ReviewFileStatus = (typeof REVIEW_FILE_STATUSES)[number];

export const REVIEW_PATCH_OMITTED_REASONS = [
  "too-large",
  "binary",
  "over-total",
] as const;
export type ReviewPatchOmittedReason =
  (typeof REVIEW_PATCH_OMITTED_REASONS)[number];

export const REVIEW_REVISION_OMITTED_REASONS = ["too-many-files"] as const;
export type ReviewRevisionOmittedReason =
  (typeof REVIEW_REVISION_OMITTED_REASONS)[number];

export const LOCKFILE_NAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
] as const;

export function isTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (/\.test\.[^/]+$/.test(base)) return true;
  if (/\.spec\.[^/]+$/.test(base)) return true;
  if (/(^|\/)__tests__\//.test(path)) return true;
  if (/(^|\/)tests\//.test(path)) return true;
  if (base.endsWith("_test.go")) return true;
  if (/^test_[^/]*\.py$/.test(base)) return true;
  return false;
}

export function isLockfilePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return (LOCKFILE_NAMES as readonly string[]).includes(base);
}

export type ReviewAttribution =
  | { ticket: string }
  | { run: string; stage?: string }
  | { kind: "setup" | "planning" | "unknown" };

export interface ReviewHunk {
  newStart: number;
  newLines: number;
  oldStart: number;
  oldLines: number;
  owners: Array<ReviewAttribution & { lines: number }>;
}

export interface ReviewFile {
  path: string;
  oldPath: string | null;
  status: ReviewFileStatus;
  oldBlob: string;
  newBlob: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  test: boolean;
  lockfile: boolean;
  patch: string | null;
  patchOmitted: ReviewPatchOmittedReason | null;
  sincePatch: string | null;
  attributions: ReviewAttribution[];
  hunks: ReviewHunk[] | null;
}

export interface ReviewBlob {
  sha: string;
  content: string;
  bytes: number;
}

export interface ReviewRevisionResult {
  stage: "review-revision";
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  complete: boolean;
  omittedReason: ReviewRevisionOmittedReason | null;
  filesCount: number;
  additions: number;
  deletions: number;
  files: ReviewFile[];
  blobs: ReviewBlob[];
  done: boolean;
}

const GIT_SHA = /^[0-9a-f]{40}$/;
const TICKET_ID = /^T-[1-9][0-9]*$/;
const RUN_ID = /^R-[1-9][0-9]*$/;

const AttributionSchema = z.union([
  z.object({ ticket: z.string().regex(TICKET_ID) }).strict(),
  z
    .object({
      run: z.string().regex(RUN_ID),
      stage: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.enum(["setup", "planning", "unknown"]) }).strict(),
]);

const HunkSchema = z
  .object({
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    owners: z.array(
      AttributionSchema.and(z.object({ lines: z.number().int() })),
    ),
  })
  .strict();

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const FileSchema = z
  .object({
    path: z.string().min(1),
    oldPath: z.string().min(1).nullable(),
    status: z.enum(REVIEW_FILE_STATUSES),
    oldBlob: z.string().regex(GIT_SHA),
    newBlob: z.string().regex(GIT_SHA),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    generated: z.boolean(),
    test: z.boolean(),
    lockfile: z.boolean(),
    patch: z.string().nullable(),
    patchOmitted: z.enum(REVIEW_PATCH_OMITTED_REASONS).nullable(),
    sincePatch: z.string().nullable(),
    attributions: z.array(AttributionSchema),
    hunks: z.array(HunkSchema).nullable(),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (
      file.patch !== null &&
      utf8Bytes(file.patch) > REVIEW_REVISION_LIMITS.maxPatchBytesPerFile
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["patch"],
        message: "patch exceeds maxPatchBytesPerFile",
      });
    }
  });

const BlobSchema = z
  .object({
    sha: z.string().regex(GIT_SHA),
    content: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((blob, ctx) => {
    const bytes = utf8Bytes(blob.content);
    if (bytes !== blob.bytes) {
      ctx.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "bytes must match content",
      });
    }
    if (blob.bytes > REVIEW_REVISION_LIMITS.maxBlobBytes) {
      ctx.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "blob exceeds maxBlobBytes",
      });
    }
  });

export const ReviewRevisionResultSchema = z
  .object({
    stage: z.literal("review-revision"),
    headSha: z.string().regex(GIT_SHA),
    baseSha: z.string().regex(GIT_SHA),
    mergeBaseSha: z.string().regex(GIT_SHA),
    complete: z.boolean(),
    omittedReason: z.enum(REVIEW_REVISION_OMITTED_REASONS).nullable(),
    filesCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(FileSchema).max(REVIEW_REVISION_LIMITS.maxFiles),
    blobs: z.array(BlobSchema),
    done: z.boolean().default(true),
  })
  .strict()
  .superRefine((result, ctx) => {
    let patchTotal = 0;
    for (const file of result.files) {
      if (file.patch) patchTotal += utf8Bytes(file.patch);
    }
    if (patchTotal > REVIEW_REVISION_LIMITS.maxPatchBytesTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: "patches exceed maxPatchBytesTotal",
      });
    }
    let blobTotal = 0;
    for (const blob of result.blobs) blobTotal += blob.bytes;
    if (blobTotal > REVIEW_REVISION_LIMITS.maxBlobBytesTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["blobs"],
        message: "blobs exceed maxBlobBytesTotal",
      });
    }
  });

export function applyReviewRevisionLimits(input: {
  files: ReviewFile[];
  blobs: ReviewBlob[];
}): {
  files: ReviewFile[];
  blobs: ReviewBlob[];
  complete: boolean;
  omittedReason: ReviewRevisionOmittedReason | null;
} {
  const max = REVIEW_REVISION_LIMITS;
  let complete = true;
  let omittedReason: ReviewRevisionOmittedReason | null = null;
  let files = input.files;
  if (files.length > max.maxFiles) {
    files = files.slice(0, max.maxFiles);
    complete = false;
    omittedReason = "too-many-files";
  }
  let patchTotal = 0;
  files = files.map((file, index) => {
    const hunks = index < max.maxLineBlameFiles ? file.hunks : null;
    if (file.binary) {
      return { ...file, patch: null, patchOmitted: "binary" as const, hunks };
    }
    if (file.patch === null) return { ...file, hunks };
    const bytes = utf8Bytes(file.patch);
    if (bytes > max.maxPatchBytesPerFile) {
      return {
        ...file,
        patch: null,
        patchOmitted: "too-large" as const,
        hunks,
      };
    }
    if (patchTotal + bytes > max.maxPatchBytesTotal) {
      return {
        ...file,
        patch: null,
        patchOmitted: "over-total" as const,
        hunks,
      };
    }
    patchTotal += bytes;
    return { ...file, hunks };
  });
  let blobTotal = 0;
  const blobs: ReviewBlob[] = [];
  for (const blob of input.blobs) {
    if (blob.bytes > max.maxBlobBytes) continue;
    if (blobTotal + blob.bytes > max.maxBlobBytesTotal) continue;
    blobTotal += blob.bytes;
    blobs.push(blob);
  }
  return { files, blobs, complete, omittedReason };
}

export function chunkReviewRevisionResult(
  result: ReviewRevisionResult,
  maxBytes = MAX_REVIEW_REVISION_COMPLETE_BYTES,
): ReviewRevisionResult[] {
  const header = {
    stage: result.stage,
    headSha: result.headSha,
    baseSha: result.baseSha,
    mergeBaseSha: result.mergeBaseSha,
    complete: result.complete,
    omittedReason: result.omittedReason,
    filesCount: result.filesCount,
    additions: result.additions,
    deletions: result.deletions,
  } as const;
  const emptySize = utf8Bytes(
    JSON.stringify({ ...header, files: [], blobs: [], done: true }),
  );
  const chunks: ReviewRevisionResult[] = [];
  let files: ReviewFile[] = [];
  let blobs: ReviewBlob[] = [];
  let used = emptySize;
  const seenBlob = new Set<string>();

  const flush = (done: boolean) => {
    chunks.push({
      ...header,
      files,
      blobs,
      done,
    });
    files = [];
    blobs = [];
    used = emptySize;
    seenBlob.clear();
  };

  const blobsFor = (file: ReviewFile, remaining: ReviewBlob[]) => {
    const shas = new Set(
      [file.oldBlob, file.newBlob].filter((sha) => sha && !/^0{40}$/.test(sha)),
    );
    return remaining.filter((blob) => shas.has(blob.sha));
  };

  const leftoverBlobs = [...result.blobs];
  for (const file of result.files) {
    const extraBlobs = blobsFor(file, leftoverBlobs).filter(
      (blob) => !seenBlob.has(blob.sha),
    );
    const piece = utf8Bytes(
      JSON.stringify({ files: [file], blobs: extraBlobs }),
    );
    if (files.length > 0 && used + piece > maxBytes) flush(false);
    files.push(file);
    for (const blob of extraBlobs) {
      blobs.push(blob);
      seenBlob.add(blob.sha);
      const index = leftoverBlobs.findIndex((item) => item.sha === blob.sha);
      if (index >= 0) leftoverBlobs.splice(index, 1);
    }
    used += piece;
  }
  if (leftoverBlobs.length > 0) {
    blobs.push(...leftoverBlobs);
  }
  if (files.length > 0 || blobs.length > 0 || chunks.length === 0) {
    flush(true);
  } else {
    const last = chunks[chunks.length - 1];
    if (last) last.done = true;
  }
  return chunks;
}
