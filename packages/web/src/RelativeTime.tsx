import { formatAbsoluteTime, formatShanghaiTime } from "./time.ts";

// Wall clock in Asia/Shanghai. The title carries seconds.
export function RelativeTime({ iso }: { iso: string; now?: Date }) {
  return (
    <time dateTime={iso} title={formatAbsoluteTime(iso)}>
      {formatShanghaiTime(iso)}
    </time>
  );
}
