// The Retry note field shared by the waiting list and the ticket page: optional, for the next Run only.

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
    <label className="retry-note" htmlFor={id}>
      这一次 Run 的说明
      <textarea
        id={id}
        value={value}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
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
