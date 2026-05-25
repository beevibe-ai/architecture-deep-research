// Parse a unified diff into a list of files, each with hunks. We keep the
// shape minimal — enough for the LLM to reason about violations and enough
// for `gh pr review --comment` to attach inline comments at the right line.

function parseHunkHeader(line) {
  // @@ -oldStart,oldCount +newStart,newCount @@ optional-context
  const match = line.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
  );
  if (!match) return null;
  return {
    old_start: Number(match[1]),
    old_count: match[2] ? Number(match[2]) : 1,
    new_start: Number(match[3]),
    new_count: match[4] ? Number(match[4]) : 1,
    section: (match[5] || "").trim()
  };
}

function parseFileHeader(line) {
  // diff --git a/path/to/file b/path/to/file
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return null;
  return { old_path: match[1], new_path: match[2] };
}

function parseDiff(raw) {
  const lines = raw.split("\n");
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  let isBinary = false;
  let newLineCursor = 0;

  function finalizeHunk() {
    if (currentHunk && currentFile) {
      currentFile.hunks.push(currentHunk);
      currentHunk = null;
    }
  }

  function finalizeFile() {
    finalizeHunk();
    if (currentFile && (currentFile.hunks.length > 0 || currentFile.binary)) {
      files.push(currentFile);
    }
    currentFile = null;
    isBinary = false;
  }

  for (const line of lines) {
    const fileHeader = parseFileHeader(line);
    if (fileHeader) {
      finalizeFile();
      currentFile = {
        old_path: fileHeader.old_path,
        new_path: fileHeader.new_path,
        binary: false,
        hunks: []
      };
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      currentFile.binary = true;
      isBinary = true;
      continue;
    }

    // Skip lines until we hit a hunk header or another file header.
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("index ") || line.startsWith("similarity index ")) continue;
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) continue;
    if (line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) continue;
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) continue;

    if (isBinary) continue;

    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      finalizeHunk();
      currentHunk = {
        ...hunkHeader,
        lines: []
      };
      newLineCursor = hunkHeader.new_start;
      continue;
    }

    if (!currentHunk) continue;

    // Inside a hunk. Each line is one of:
    //  ' foo'  context (unchanged)
    //  '+foo'  addition
    //  '-foo'  deletion
    //  '\ ...' no-newline marker (ignore)
    if (line.startsWith("\\")) continue;
    const marker = line[0];
    const content = line.slice(1);

    if (marker === "+") {
      currentHunk.lines.push({
        kind: "add",
        new_line: newLineCursor,
        text: content
      });
      newLineCursor += 1;
    } else if (marker === "-") {
      currentHunk.lines.push({
        kind: "del",
        new_line: null,
        text: content
      });
    } else if (marker === " " || marker === undefined || marker === "") {
      currentHunk.lines.push({
        kind: "context",
        new_line: newLineCursor,
        text: content
      });
      newLineCursor += 1;
    }
  }
  finalizeFile();
  return files;
}

// Render one file's hunks back into a compact form the LLM can read. We
// keep line numbers visible so the model can emit precise inline-comment
// targets in its violation output.
function renderFileForLlm(file) {
  const lines = [`FILE: ${file.new_path}`];
  for (const hunk of file.hunks) {
    lines.push(
      `HUNK @ ${file.new_path}:${hunk.new_start}-${hunk.new_start + hunk.new_count - 1}${
        hunk.section ? ` (${hunk.section})` : ""
      }`
    );
    for (const lineEntry of hunk.lines) {
      const tag =
        lineEntry.kind === "add"
          ? "+"
          : lineEntry.kind === "del"
            ? "-"
            : " ";
      const ln =
        lineEntry.new_line != null ? String(lineEntry.new_line).padStart(5) : "     ";
      lines.push(`${ln} ${tag} ${lineEntry.text}`);
    }
  }
  return lines.join("\n");
}

export { parseDiff, renderFileForLlm };
