const BASE = "";

async function jsonFetch(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    ...init
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* ignore */
    }
    throw new Error(`${response.status} ${response.statusText} — ${detail.slice(0, 200)}`);
  }
  return response.json();
}

export function listRuns() {
  return jsonFetch("/api/runs");
}

export function getRun(id) {
  return jsonFetch(`/api/runs/${encodeURIComponent(id)}`);
}

export function getArtifact(id, name) {
  return jsonFetch(`/api/runs/${encodeURIComponent(id)}/artifact/${encodeURIComponent(name)}`);
}

export function startRun(body) {
  return jsonFetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
}

/**
 * Subscribe to the SSE event stream for a run. Returns a close function.
 * @param {string} id
 * @param {(event: any) => void} onMessage
 * @param {(error: any) => void} [onError]
 */
export function subscribeEvents(id, onMessage, onError) {
  const url = `${BASE}/api/runs/${encodeURIComponent(id)}/events`;
  const source = new EventSource(url);
  source.onmessage = (msg) => {
    try {
      onMessage(JSON.parse(msg.data));
    } catch (error) {
      onError?.(error);
    }
  };
  source.onerror = (error) => {
    onError?.(error);
  };
  return () => source.close();
}
