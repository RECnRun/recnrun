import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// PLAN.md R3: the launcher package is POSIX sh and runs no other interpreter.
const RUNTIME = /(?:^|[\s;&|(`{]|\$\()(jq|node|python3?|perl|ruby|eval|bash)(?=[\s;&|)`}]|$)/;
const BASHISMS = [
  // [[:class:]] inside a pattern is POSIX.
  [/\[\[(?!:)/, "[["],
  [/(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*\+?=\(/, "array assignment"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[/, "array expansion"],
  [/(?:^|[\s;&|(])(?:declare|typeset)\s+-[A-Za-z]*[aA]/, "declare -a"],
  [/(?:^|[\s;&|(])local\s+-[A-Za-z]*n/, "local -n"],
  [/(?:^|[\s;&|(])function\s/, "function keyword"],
  [/\$\{[^}]*(?:,,|\^\^)[^}]*\}/, "case-changing expansion"],
];

/** The code of a line: no comment, no single-quoted text (a quote or # inside "..." is not tracked). */
function code(line) {
  const unquoted = line.replace(/'[^']*'/g, "''");
  return unquoted.replace(/(?:^|\s)#.*$/, "");
}

/** Findings of one script's text as { file, line, rule, text }. */
export function scanText(file, text) {
  const lines = text.split("\n");
  const found = [];
  const add = (line, rule, detail) => found.push({ file, line, rule, text: detail });
  if (lines[0] !== "#!/bin/sh") add(1, "shebang", lines[0]);
  lines.forEach((raw, index) => {
    if (index === 0 && raw.startsWith("#!")) return;
    const line = code(raw);
    const runtime = RUNTIME.exec(line);
    if (runtime) add(index + 1, "runtime", runtime[1]);
    for (const [pattern, name] of BASHISMS) {
      if (pattern.test(line)) add(index + 1, "bashism", name);
    }
  });
  return found;
}

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // Fixtures hold the offences this scanner is tested against.
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : scripts(path);
    return entry.name.endsWith(".sh") ? [path] : [];
  });
}

/** Findings of every *.sh under a package directory; its fixtures folders are skipped. */
export function scanPackage(root) {
  return scripts(root).flatMap((path) =>
    scanText(relative(root, path), readFileSync(path, "utf8")),
  );
}
