import { useEffect, useRef, useState } from "react";

/**
 * Polls a fetcher fn on an interval. Use when SSE is unavailable or you
 * just need to refresh JSON artifacts that the server reads from disk.
 *
 * Pass `enabled: false` to suspend the interval (e.g. once a run reaches a
 * terminal status). One last tick still fires on transition so the final
 * state is captured.
 *
 * @param {() => Promise<T>} fetcher
 * @param {{ interval?: number, immediate?: boolean, enabled?: boolean, deps?: any[] }} [opts]
 */
export function usePolling(fetcher, opts = {}) {
  const { interval = 3000, immediate = true, enabled = true, deps = [] } = opts;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate && enabled);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (!enabled) return undefined;
    if (immediate) tick();
    const id = setInterval(tick, interval);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, immediate, enabled, ...deps]);

  return { data, error, loading };
}
