export const CAPSULE_VERSION = "0.1.0";

export function emptyCapsule() {
  return {
    version: CAPSULE_VERSION,
    id: "",
    source: "claude-code",
    publishedAt: new Date().toISOString(),
    title: "",
    summary: "",
    metadata: {
      model: "",
      durationMs: 0,
      messageCount: 0,
      toolCallCount: 0,
      fileChangeCount: 0,
      abandonedCount: 0,
      outcome: "in-progress",
      topics: [],
    },
    events: [],
    context: { files: [], repo: "", branch: "" },
    visibility: "unlisted",
  };
}

export function isCapsule(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.version === "string" &&
    Array.isArray(value.events)
  );
}
