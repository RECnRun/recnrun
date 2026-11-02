// Checks the repository's Markdown: every relative link resolves and every anchor names a heading.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderCapabilitiesMarkdown } from "../packages/protocol/scripts/render-capabilities.ts";
import { CAPABILITY_MATRIX } from "../packages/protocol/src/index.ts";

const SKIPPED_DIRECTORIES = new Set([
  ".artifacts",
  ".git",
  ".jscpd",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
// Agent worktrees are whole checkouts of other branches.
const SKIPPED_PATHS = new Set([join(".claude", "worktrees")]);
const LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HTML_ANCHOR = /<a\s+[^>]*(?:id|name)="([^"]+)"/g;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Lists Markdown files under root, skipping build output, dependencies, and symlinks. */
function markdownFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) {
      const skipped =
        SKIPPED_DIRECTORIES.has(entry.name) || SKIPPED_PATHS.has(relative(root, path));
      return skipped ? [] : markdownFiles(root, path);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

/** Yields each line outside fenced code blocks, with inline code removed, and its 1-based number. */
function* proseLines(text) {
  let fence;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? undefined : marker;
      continue;
    }
    if (!fence) yield { line: line.replace(/`+[^`]*`+/g, "``"), number: index + 1, raw: line };
  }
}

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replaceAll(" ", "-");
}

/** Returns every anchor a Markdown file defines, with GitHub's -1, -2 suffixes for repeats. */
function anchors(text) {
  const found = new Set();
  const counts = new Map();
  for (const { raw } of proseLines(text)) {
    for (const [, id] of raw.matchAll(HTML_ANCHOR)) found.add(id);
    const heading = HEADING.exec(raw)?.[2];
    if (!heading) continue;
    const base = slug(heading);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  return found;
}

function splitTarget(target) {
  const hash = target.indexOf("#");
  if (hash < 0) return { path: target, anchor: undefined };
  return { path: target.slice(0, hash), anchor: target.slice(hash + 1) };
}

function linkError({ root, file, target, anchorsOf }) {
  if (SCHEME.test(target) || target.startsWith("#")) return undefined;
  const { path, anchor } = splitTarget(target);
  const base = path.startsWith("/") ? root : dirname(file);
  const resolved = resolve(base, decodeURIComponent(path.replace(/^\//, "")));
  if (!existsSync(resolved))
    return `broken link ${target}: ${relative(root, resolved)} does not exist`;
  if (!anchor || !resolved.endsWith(".md") || statSync(resolved).isDirectory()) return undefined;
  if (anchorsOf(resolved).has(decodeURIComponent(anchor).toLowerCase())) return undefined;
  return `broken anchor ${target}: ${relative(root, resolved)} has no heading #${anchor}`;
}

/** Reports relative links whose file is missing or whose anchor matches no heading. */
function checkLinks({ root, files }) {
  const cache = new Map();
  const anchorsOf = (path) => {
    if (!cache.has(path)) cache.set(path, anchors(readFileSync(path, "utf8")));
    return cache.get(path);
  };
  return files.flatMap((file) =>
    [...proseLines(readFileSync(file, "utf8"))].flatMap(({ line, number }) =>
      [...line.matchAll(LINK)].flatMap(([, target]) => {
        const message = linkError({ root, file, target, anchorsOf });
        return message ? [`${relative(root, file)}:${number}: ${message}`] : [];
      }),
    ),
  );
}

/** Reports docs/CAPABILITIES.md when it differs from the matrix in packages/protocol. */
function checkCapabilities({ root }) {
  if (!existsSync(join(root, "packages", "protocol"))) return [];
  const file = join(root, "docs", "CAPABILITIES.md");
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current === renderCapabilitiesMarkdown(CAPABILITY_MATRIX)) return [];
  return ["docs/CAPABILITIES.md: stale; run vp run capabilities:generate"];
}

// Extension point: each check gets { root, files } and returns "file:line: message" strings.
export const checks = [checkLinks, checkCapabilities];

/** Runs every check against the Markdown under root and returns the failures. */
export function checkDocs(root) {
  const files = markdownFiles(root).sort();
  return checks.flatMap((check) => check({ root, files }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  const errors = checkDocs(root);
  for (const error of errors) console.error(error.split(sep).join("/"));
  if (errors.length) process.exitCode = 1;
  else console.log(`Checked the Markdown links under ${root}.`);
}
