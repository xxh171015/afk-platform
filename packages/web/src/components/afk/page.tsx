import type { ReactNode } from "react";

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle ? (
            <div className="mt-1 text-[13px] text-muted-foreground">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
