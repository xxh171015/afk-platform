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
    <div className="afk-page mx-auto w-full max-w-[1440px] px-6 py-7 lg:px-10 lg:py-9">
      <div className="afk-page-heading mb-7 flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div className="min-w-0">
          <p className="afk-eyebrow mb-2">AFK / CONTROL TOWER</p>
          <h1 className="text-2xl font-semibold tracking-tight lg:text-[30px]">
            {title}
          </h1>
          {subtitle ? (
            <div className="mt-2 max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">
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
