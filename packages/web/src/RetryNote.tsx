import { cn } from "./lib/utils.ts";

export function RetryNoteField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
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
