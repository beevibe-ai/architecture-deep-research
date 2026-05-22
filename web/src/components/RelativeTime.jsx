import { useEffect, useState } from "react";

/**
 * Renders "Xs ago" / "Xm ago" relative to `timestamp`, ticking every 5s.
 * Use for live "last updated" indicators in polled UIs.
 */
export default function RelativeTime({ timestamp, tickMs = 5000 }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return <span>just now</span>;
  if (seconds < 60) return <span>{seconds}s ago</span>;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return <span>{minutes}m ago</span>;
  const hours = Math.round(minutes / 60);
  return <span>{hours}h ago</span>;
}
