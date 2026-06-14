// Thin wrapper over the VS Code webview messaging API. acquireVsCodeApi is
// injected by the host exactly once, so we grab it here and share the handle.

const api = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

export function post(message) {
  if (api) api.postMessage(message);
}

// Subscribe to messages from the host. Returns an unsubscribe fn.
export function onMessage(handler) {
  const listener = (event) => handler(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
