import { useEffect, useState } from 'react';

/**
 * The time, re-read every `everyMs`, for text that goes stale on its own ("last sent 3 min ago").
 * Only screens use it; the queue itself takes its clock from the runtime.
 */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
}
