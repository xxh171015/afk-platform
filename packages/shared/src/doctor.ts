import { z } from "zod";

// What `plat doctor` checks on a planning machine and stores per project+machine
// (GET/PUT /projects/{id}/doctor-report). Failures never fail the command: they
// name what is missing and the command that fixes it.

export const DOCTOR_ITEM_STATUSES = ["ok", "fail", "warn"] as const;
export type DoctorItemStatus = (typeof DOCTOR_ITEM_STATUSES)[number];

export const DoctorItemSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(100),
  status: z.enum(DOCTOR_ITEM_STATUSES),
  detail: z.string().max(2000).optional(),
  command: z.string().max(500).optional(),
});
export type DoctorItem = z.infer<typeof DoctorItemSchema>;

export const DoctorReportSchema = z.object({
  machine: z.string().min(1).max(200),
  checkedAt: z.string(),
  items: z.array(DoctorItemSchema).max(50),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export const DoctorReportPutSchema = z
  .object({
    machine: z.string().min(1).max(200),
    items: z.array(DoctorItemSchema).max(50),
  })
  .strict();
export type DoctorReportPut = z.infer<typeof DoctorReportPutSchema>;

// Filenames of planning-doc changes at `plat tickets import`. The page confirm
// precheck uses this so it can name what it would drop (ADR 0005: it never
// uploads the files). `unknown` is the default when import did not say.
export const PLANNING_DOCS_AT_IMPORT_STATUSES = [
  "changed",
  "clean",
  "unknown",
] as const;
export type PlanningDocsAtImportStatus =
  (typeof PLANNING_DOCS_AT_IMPORT_STATUSES)[number];

export const PlanningDocsAtImportSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("changed"),
    files: z.array(z.string().min(1).max(500)).min(1).max(200),
  }),
  z.object({ status: z.literal("clean") }),
  z.object({ status: z.literal("unknown") }),
]);
export type PlanningDocsAtImport = z.infer<typeof PlanningDocsAtImportSchema>;
