import { AlertTriangle, Inbox, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center", className)}>
      <div className="mb-3 text-subtle-foreground">{icon ?? <Inbox className="size-5" />}</div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center rounded-md border border-state-blocked/30 bg-state-blocked/5 px-6 py-10 text-center", className)}>
      <AlertTriangle className="mb-3 size-5 text-state-blocked" />
      <p className="text-sm font-medium">加载失败</p>
      <p className="mt-1 max-w-md font-mono text-xs text-muted-foreground">{msg}</p>
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-4" onClick={onRetry}>
          <RotateCw /> 重试
        </Button>
      )}
    </div>
  );
}

/** 轮询失败但仍有旧数据时的小提示 */
export function StaleNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="status" className="flex items-center gap-2 rounded-sm border border-state-paused/30 bg-state-paused/8 px-2 py-1 text-xs text-state-paused">
      <AlertTriangle className="size-3.5" /> 刷新失败，显示的是上次的数据
    </div>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export { Skeleton };
