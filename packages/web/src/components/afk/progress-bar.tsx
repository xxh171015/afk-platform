import { cn } from "../../lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

const segs = [
  { key: "done", label: "done 完成", cls: "bg-state-done" },
  { key: "active", label: "running 进行中", cls: "bg-state-running" },
  { key: "blocked", label: "blocked 受阻", cls: "bg-state-blocked" },
  { key: "pending", label: "pending 等待", cls: "bg-state-neutral/40" },
  { key: "cancelled", label: "cancelled 已取消", cls: "bg-state-neutral/20" },
] as const;

export type Progress = {
  total: number;
  done: number;
  active: number;
  blocked: number;
  pending: number;
  cancelled: number;
};

export function SegmentedProgress({
  progress,
  className,
}: {
  progress: Progress;
  className?: string;
}) {
  const total = Math.max(progress.total, 1);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex h-1.5 w-full cursor-help overflow-hidden rounded-full bg-muted",
            className,
          )}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={`完成 ${progress.done}/${progress.total}`}
        >
          {segs.map((s) =>
            progress[s.key] > 0 ? (
              <div
                key={s.key}
                className={cn(
                  "h-full border-r border-background last:border-r-0",
                  s.cls,
                )}
                style={{ width: `${(progress[s.key] / total) * 100}%` }}
              />
            ) : null,
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="min-w-36">
        {segs.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className={cn("size-2 rounded-sm", s.cls)} />
            <span className="flex-1 font-mono">{s.label}</span>
            <span className="font-mono tabular">{progress[s.key]}</span>
          </div>
        ))}
        <div className="mt-1 border-t pt-1 text-right font-mono text-xs tabular">
          total {progress.total}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
