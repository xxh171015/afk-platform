import { useWorkbench } from "./Workbench.tsx";

export function DiskBanner() {
  const board = useWorkbench();
  const status = board.data?.status;
  if (!status || (status.diskLevel !== "warn" && status.diskLevel !== "stop")) {
    return null;
  }
  const { diskLevel: level, warnGib, stopGib } = status;
  return (
    <div
      role="status"
      data-testid="disk-banner"
      className={
        level === "stop"
          ? "border-b border-state-blocked/40 bg-state-blocked/10 px-4 py-2 text-sm text-state-blocked"
          : "border-b border-border bg-muted/40 px-4 py-2 text-sm"
      }
    >
      {level === "stop"
        ? `磁盘剩余不足 ${stopGib} GiB，worker 已停止领取新作业`
        : `磁盘剩余不足 ${warnGib} GiB`}
    </div>
  );
}
