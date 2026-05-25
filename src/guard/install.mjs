import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const HOOK_COMMAND = "adr guard pre-write";
const PRECOMMIT_BANNER = "# adr guard pre-commit";
const PRECOMMIT_LINE = "adr guard pre-commit";

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOr(target, fallback) {
  try {
    const raw = await readFile(target, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function ensureHookEntry(settings) {
  const next = { ...(settings || {}) };
  next.hooks = next.hooks || {};
  const existing = Array.isArray(next.hooks.PreToolUse)
    ? next.hooks.PreToolUse
    : [];

  // Look for an existing matcher group with our command; if present, leave
  // it alone. Idempotency matters — re-running install shouldn't double up.
  const alreadyInstalled = existing.some((entry) =>
    Array.isArray(entry.hooks)
      ? entry.hooks.some(
          (h) => h.type === "command" && h.command === HOOK_COMMAND
        )
      : false
  );

  if (alreadyInstalled) return { settings: next, addedClaude: false };

  existing.push({
    matcher: "Edit|Write|MultiEdit",
    hooks: [
      {
        type: "command",
        command: HOOK_COMMAND
      }
    ]
  });

  next.hooks.PreToolUse = existing;
  return { settings: next, addedClaude: true };
}

async function installClaudeHook(repoPath) {
  const dir = path.join(repoPath, ".claude");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "settings.local.json");
  const current = await readJsonOr(file, {});
  const { settings, addedClaude } = ensureHookEntry(current);
  if (addedClaude) {
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { path: file, added: addedClaude };
}

async function installPreCommitHook(repoPath) {
  const gitDir = path.join(repoPath, ".git");
  if (!(await exists(gitDir))) {
    return { path: null, added: false, skipped: "not_a_git_repo" };
  }
  const hooksDir = path.join(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const file = path.join(hooksDir, "pre-commit");
  if (await exists(file)) {
    const existing = await readFile(file, "utf8");
    if (existing.includes(PRECOMMIT_LINE)) {
      return { path: file, added: false, reason: "already_installed" };
    }
    // Append our line to the existing hook — preserves whatever else the
    // user has running there.
    const next = existing.endsWith("\n") ? existing : `${existing}\n`;
    await writeFile(
      file,
      `${next}\n${PRECOMMIT_BANNER}\n${PRECOMMIT_LINE}\n`
    );
    return { path: file, added: true, mode: "appended" };
  }
  await writeFile(
    file,
    `#!/bin/sh\n${PRECOMMIT_BANNER}\n${PRECOMMIT_LINE}\n`
  );
  await chmod(file, 0o755);
  return { path: file, added: true, mode: "created" };
}

async function installGuards({ repoPath = process.cwd() } = {}) {
  const claude = await installClaudeHook(repoPath);
  const precommit = await installPreCommitHook(repoPath);
  return { claude, precommit };
}

export { installGuards, installClaudeHook, installPreCommitHook };
