import type { BlockedReason, SpecState, TicketState } from "@afk/shared";
import { Check, Copy } from "lucide-react";
import { Children, isValidElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useChangeFlash } from "../../hooks/use-change-flash.ts";
import { cn } from "../../lib/utils.ts";
import { paths } from "../../paths.ts";
import {
  blockedReasonLabel,
  shortSha,
  specStateLabel,
  ticketStateLabel,
} from "../../status.ts";
import { Button } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

type Tone =
  | "neutral"
  | "queued"
  | "running"
  | "merging"
  | "done"
  | "blocked"
  | "paused"
  | "review"
  | "partial"
  | "draft"
  | "cancelled";

const toneClass: Record<Tone, string> = {
  neutral: "text-state-neutral bg-state-neutral/10 border-state-neutral/25",
  queued: "text-state-queued bg-state-queued/12 border-state-queued/30",
  running: "text-state-running bg-state-running/12 border-state-running/30",
  merging: "text-state-merging bg-state-merging/12 border-state-merging/30",
  done: "text-state-done bg-state-done/12 border-state-done/30",
  blocked: "text-state-blocked bg-state-blocked/12 border-state-blocked/35",
  paused: "text-state-paused bg-state-paused/12 border-state-paused/35",
  review: "text-state-review bg-state-review/12 border-state-review/30",
  partial: "text-state-partial bg-state-partial/12 border-state-partial/30",
  draft:
    "text-muted-foreground bg-transparent border-dashed border-border-strong",
  cancelled:
    "text-state-neutral bg-state-neutral/8 border-state-neutral/20 line-through",
};

const dotClass: Record<Tone, string> = {
  neutral: "bg-state-neutral",
  queued: "bg-state-queued",
  running: "bg-state-running animate-breathe",
  merging: "bg-state-merging",
  done: "bg-state-done",
  blocked: "bg-state-blocked",
  paused: "bg-state-paused",
  review: "bg-state-review",
  partial: "bg-state-partial",
  draft: "bg-muted-foreground",
  cancelled: "bg-state-neutral",
};

const ticketTone: Record<TicketState, Tone> = {
  pending: "neutral",
  queued: "queued",
  running: "running",
  merging: "merging",
  done: "done",
  blocked: "blocked",
  cancelled: "cancelled",
};

const specTone: Record<SpecState, Tone> = {
  draft: "draft",
  planned: "queued",
  running: "running",
  finalizing: "merging",
  "awaiting-review": "review",
  "partially-merged": "partial",
  reworking: "running",
  merged: "done",
  paused: "paused",
  cancelled: "cancelled",
};

export function toneForState(
  state: TicketState | SpecState,
  kind: "ticket" | "spec",
): Tone {
  return kind === "ticket"
    ? ticketTone[state as TicketState]
    : specTone[state as SpecState];
}

export function ticketBorderClass(state: TicketState): string {
  const classes: Record<TicketState, string> = {
    pending: "border-l-state-neutral",
    queued: "border-l-state-queued",
    running: "border-l-state-running afk-node-running",
    merging: "border-l-state-merging",
    done: "border-l-state-done",
    blocked: "border-l-state-blocked",
    cancelled: "border-l-state-neutral",
  };
  return classes[state];
}

function badgeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? badgeText(child.props.children)
          : "",
    )
    .join("");
}

export function Pill({
  tone,
  children,
  title,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const flashing = useChangeFlash(`${tone}:${badgeText(children)}`);
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 font-mono text-[11px] leading-none whitespace-nowrap",
        toneClass[tone],
        flashing && "afk-change-flash",
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", dotClass[tone])}
        aria-hidden
      />
      {children}
    </span>
  );
}

export function StateBadge({
  kind,
  state,
  className,
}: {
  kind: "ticket" | "spec";
  state: string;
  className?: string;
}) {
  const text =
    kind === "ticket" ? ticketStateLabel(state) : specStateLabel(state);
  const tone = toneForState(state as TicketState & SpecState, kind);
  return (
    <Pill tone={tone} title={state} className={cn("font-sans", className)}>
      {text}
    </Pill>
  );
}

export function ReasonBadge({
  reason,
  detail,
  className,
}: {
  reason: string;
  detail?: string | null;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          title={reason}
          className={cn(
            "inline-flex h-5 cursor-help items-center rounded-sm border border-state-blocked/30 bg-state-blocked/8 px-1.5 font-mono text-[11px] text-state-blocked",
            className,
          )}
        >
          {blockedReasonLabel(reason)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">{blockedReasonLabel(reason)}</p>
        {detail ? (
          <p className="mt-1 text-muted-foreground">{detail}</p>
        ) : (
          <p className="mt-1 font-mono text-muted-foreground">{reason}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(
        `已复制 ${text.length > 16 ? `${text.slice(0, 12)}…` : text}`,
      );
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("复制失败");
    }
  };
  return { copied, copy };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copy(text);
      }}
      className="ml-0.5 hidden rounded-sm p-0.5 text-subtle-foreground hover:bg-accent hover:text-foreground group-hover/chip:inline-flex"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

const chipBase =
  "group/chip inline-flex h-5 items-center rounded-sm border border-border bg-surface px-1.5 font-mono text-[11px] text-foreground tabular";

export function IdChip({
  displayId,
  id,
  className,
}: {
  displayId: string;
  id: number | string;
  className?: string;
}) {
  const prefix = displayId.split("-")[0];
  const href =
    prefix === "S"
      ? paths.spec(Number(id))
      : prefix === "T"
        ? paths.ticket(Number(id))
        : prefix === "R"
          ? paths.run(Number(id))
          : undefined;
  const inner = <span className="hover:underline">{displayId}</span>;
  return (
    <span className={cn(chipBase, className)}>
      {href ? <a href={href}>{inner}</a> : inner}
      <CopyButton text={displayId} label={`复制 ${displayId}`} />
    </span>
  );
}

export function ShaChip({
  sha,
  className,
}: {
  sha: string | null;
  className?: string;
}) {
  const { copied, copy } = useCopy();
  if (!sha)
    return (
      <span className="font-mono text-[11px] text-subtle-foreground">—</span>
    );
  const short = shortSha(sha);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={short}
          title={sha}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void copy(sha);
          }}
          className={cn(chipBase, "gap-1 text-muted-foreground", className)}
        >
          {short}
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]">{sha}</TooltipContent>
    </Tooltip>
  );
}

const repoClasses = [
  "text-repo-1 border-repo-1/30 bg-repo-1/10",
  "text-repo-2 border-repo-2/30 bg-repo-2/10",
  "text-repo-3 border-repo-3/30 bg-repo-3/10",
  "text-repo-4 border-repo-4/30 bg-repo-4/10",
  "text-repo-5 border-repo-5/30 bg-repo-5/10",
  "text-repo-6 border-repo-6/30 bg-repo-6/10",
];

export function repoColorIndex(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % repoClasses.length;
}

export function RepoTag({
  name,
  short,
  className,
}: {
  name: string;
  short?: boolean;
  className?: string;
}) {
  const label = short ? name.replace(/^afk-pilot-/, "") : name;
  return (
    <span
      title={name}
      className={cn(
        "inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[11px]",
        repoClasses[repoColorIndex(name)],
        className,
      )}
    >
      {label}
    </span>
  );
}

export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <code
      title={title}
      className={cn("font-mono text-[12px] text-foreground/90", className)}
    >
      {children}
    </code>
  );
}

export type { BlockedReason };
