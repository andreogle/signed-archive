import { type JSX, useEffect, useState } from 'react';
import { formatAge, formatTime } from '../format.ts';

// How long ago a query last fetched, ticking every second, so a viewer can see the page is live. `at` is the query's
// dataUpdatedAt (unix milliseconds); 0 means it has not fetched yet.
export function UpdatedAgo({ at }: { at: number }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (at === 0) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return <span title={`Last fetched ${formatTime(Math.floor(at / 1000))}`}>updated {formatAge(seconds)} ago</span>;
}
