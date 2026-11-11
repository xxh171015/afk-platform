import { cn } from "./lib/utils.ts";

// What a ticket retry that keeps the work does with the note, or without one.
export const TICKET_RETRY_HINT =
  "保留已有工作时：不写说明，从门禁接着跑；写了说明，agent 按说明接着改。";

export function RetryNoteField({
  id,
  value,
  onChange,
  hint,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const field = (
    <label className="grid gap-1.5 text-[13px]" htmlFor={id}>
      这一次 Run 的说明
      <textarea
        id={id}
        value={value}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "w-full rounded-md border bg-background px-3 py-2 font-sans text-[13px] leading-6",
        )}
      />
    </label>
  );
  if (!hint) return field;
  return (
    <div className="grid gap-1">
      {field}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function retryTicketBody(
  mode: "continue" | "restart",
  note: string,
): { mode: "continue" | "restart"; note?: string } {
  const trimmed = note.trim();
  return trimmed === "" ? { mode } : { mode, note: trimmed };
}

export function retryFinalBody(note: string): { note?: string } {
  const trimmed = note.trim();
  return trimmed === "" ? {} : { note: trimmed };
}
