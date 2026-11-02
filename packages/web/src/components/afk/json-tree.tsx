export function JsonTree({
  value,
  name = "output",
  depth = 0,
}: {
  value: unknown;
  name?: string;
  depth?: number;
}) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="break-words font-mono text-[11px] leading-6">
        <span className="text-muted-foreground">{name}: </span>
        {JSON.stringify(value)}
      </div>
    );
  }
  const entries = Object.entries(value);
  return (
    <details open={depth < 1} className="font-mono text-[11px] leading-6">
      <summary className="cursor-pointer text-muted-foreground">
        {name}{" "}
        {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
      </summary>
      <div className="ml-3 border-l pl-3">
        {entries.map(([key, item]) => (
          <JsonTree key={key} name={key} value={item} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}
