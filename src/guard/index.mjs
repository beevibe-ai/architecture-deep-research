import { runPreWriteHook } from "./pre-write.mjs";
import { runPreCommitHook } from "./pre-commit.mjs";
import { installGuards, uninstallGuards } from "./install.mjs";

async function guard({ inputPath, flags = {} } = {}) {
  const sub = inputPath || "status";
  if (sub === "install") {
    const result = await installGuards({ repoPath: flags.repo || process.cwd() });
    console.log("");
    console.log(
      result.claude.added
        ? `Installed Claude Code pre-write hook in ${result.claude.path}.`
        : `Claude Code pre-write hook already installed at ${result.claude.path}.`
    );
    if (result.precommit.skipped) {
      console.log(
        `Skipped git pre-commit (${result.precommit.skipped}). Run \`git init\` first.`
      );
    } else if (result.precommit.added) {
      console.log(
        `${result.precommit.mode === "appended" ? "Appended" : "Created"} git pre-commit hook at ${result.precommit.path}.`
      );
    } else {
      console.log(`Git pre-commit hook already installed at ${result.precommit.path}.`);
    }
    console.log("");
    console.log(
      "Next: edit a file in this repo through Claude Code — the pre-write hook will surface the team's principles when relevant."
    );
    return result;
  }
  if (sub === "uninstall") {
    const result = await uninstallGuards({
      repoPath: flags.repo || process.cwd()
    });
    console.log("");
    console.log(
      result.claude.removed
        ? `Removed Claude Code pre-write hook from ${result.claude.path}.`
        : `Claude Code hook not present (${result.claude.reason}).`
    );
    console.log(
      result.precommit.removed
        ? result.precommit.deleted
          ? `Deleted git pre-commit hook at ${result.precommit.path} (it had no other content).`
          : `Stripped adr-guard line from git pre-commit at ${result.precommit.path}.`
        : `Git pre-commit hook not present (${result.precommit.reason}).`
    );
    return result;
  }
  if (sub === "pre-write") {
    return runPreWriteHook({ repoPath: flags.repo });
  }
  if (sub === "pre-commit") {
    const result = await runPreCommitHook({
      repoPath: flags.repo || process.cwd(),
      failOn: flags["fail-on"] || "high"
    });
    if (result.blocked) {
      process.exitCode = 1;
    }
    return result;
  }
  throw new Error(
    `Unknown adr guard subcommand: ${sub}. Try \`adr guard install\`, \`adr guard pre-write\`, or \`adr guard pre-commit\`.`
  );
}

export { guard };
