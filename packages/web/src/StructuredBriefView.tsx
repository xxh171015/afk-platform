import { paths } from "./paths.ts";
import type { StructuredBrief } from "./structured-brief.ts";

export function StructuredBriefView({
  brief,
  runId,
}: {
  brief: StructuredBrief;
  runId: number;
}) {
  const { evidence } = brief;
  return (
    <div className="brief grid gap-2 text-sm" role="note">
      <p>
        <strong>{brief.summary}</strong>
        <span className="text-muted-foreground"> · {brief.step}</span>
      </p>
      {evidence.failingTests ? (
        <ul>
          {evidence.failingTests.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
      {evidence.command ? <p>{evidence.command}</p> : null}
      {evidence.lastLogLines ? (
        <pre className="overflow-x-auto whitespace-pre-wrap">
          {evidence.lastLogLines}
        </pre>
      ) : null}
      {evidence.conflictFiles ? (
        <ul>
          {evidence.conflictFiles.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      ) : null}
      {evidence.findingsCount !== undefined ? (
        <p>{evidence.findingsCount} 条 review 意见</p>
      ) : null}
      <p>
        <a href={paths.run(runId)}>{`R-${runId}`}</a>
      </p>
      <p>{brief.recommendedAction}</p>
    </div>
  );
}
