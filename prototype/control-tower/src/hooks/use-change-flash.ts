import { useEffect, useRef, useState } from "react";

export function useChangeFlash(value: string | number, increaseOnly = false) {
  const previous = useRef(value);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    const changed = previous.current !== value && (!increaseOnly || Number(value) > Number(previous.current));
    previous.current = value;
    if (!changed) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 850);
    return () => clearTimeout(timer);
  }, [value, increaseOnly]);
  return flashing;
}