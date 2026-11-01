import { useEffect, useState } from "react";
import { absoluteTime, relativeTime } from "@/lib/time";

export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  return <time dateTime={value} title={absoluteTime(value)} className={className}>{now ? relativeTime(value, now) : "—"}</time>;
}