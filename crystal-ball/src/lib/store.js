// Capsules live in localStorage for v0 — no backend persistence.
// Capsule id is part of the URL path, so links work as long as the recipient
// loads the same machine. For real sharing we'll need an actual store; this
// is intentionally a stub to keep MVP small.

const KEY = "crystal-ball:capsules";

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function writeAll(map) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function saveCapsule(capsule) {
  const all = readAll();
  all[capsule.id] = capsule;
  writeAll(all);
}

export function loadCapsule(id) {
  return readAll()[id] || null;
}

export function listCapsules() {
  const all = readAll();
  return Object.values(all).sort((a, b) =>
    (b.publishedAt || "").localeCompare(a.publishedAt || "")
  );
}

export function deleteCapsule(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}
