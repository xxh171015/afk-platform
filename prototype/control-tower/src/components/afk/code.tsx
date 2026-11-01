import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

/** 可折叠的等宽代码块，默认展示前 N 行 */
export function CollapsibleCode({ text, lines = 12, className }: { text: string; lines?: number; className?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const all = text.replace(/\n+$/, "").split("\n");
  const overflow = all.length > lines;
  const shown = open || !overflow ? all : all.slice(0, lines);
  return (
    <div className={cn("overflow-hidden rounded-md border bg-background", className)}>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-foreground/85">
        {shown.map((l, i) => (
          <div key={i} className="flex">
            <span className="mr-3 w-6 shrink-0 text-right text-subtle-foreground select-none tabular">{i + 1}</span>
            <span className="whitespace-pre">{l || " "}</span>
          </div>
        ))}
      </pre>
      {overflow && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-center gap-1 border-t bg-surface py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {open ? <><ChevronUp className="size-3" /> 收起</> : <><ChevronDown className="size-3" /> 展开其余 {all.length - lines} 行</>}
        </button>
      )}
    </div>
  );
}

/** 一键复制的命令 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-md border bg-background pr-1 pl-2.5 font-mono text-[12px]">
      <span className="text-subtle-foreground select-none">$</span>
      <span>{command}</span>
      <button
        type="button"
        aria-label={`复制命令 ${command}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            toast.success("命令已复制");
            setTimeout(() => setCopied(false), 1200);
          } catch {
            toast.error("复制失败");
          }
        }}
        className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}
