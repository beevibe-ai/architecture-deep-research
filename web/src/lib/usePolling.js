import { useEffect, useRef, useState } from "react";

/**
 * Polls a fetcher fn on an interval. Use when SSE is unavailable or you
 * just need to refresh JSON artifacts that the server reads from disk.
 *
 * @param {() => Promise<T>} fetcher
 * @param {{ interval?: number, immediate?: boolean, deps?: any[] }} [opts]
 */
export function usePolling(fetcher, opts = {}) {
  const { interval = 3000, immediate = true, deps = [] } = opts;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate);
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
    if (immediate) tick();
    const id = setInterval(tick, interval);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, immediate, ...deps]);

  return { data, error, loading };
}
