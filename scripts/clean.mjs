// Deletes build outputs, test artifacts, tool caches, and the dev Chromium profile; keeps dependencies.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const workspaces = ["apps", "packages"].flatMap((group) =>
  readdirSync(join(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name)),
);
const caches = [".", ...workspaces].flatMap((dir) =>
  [".vite", ".vite-temp", ".vitest-cache", ".cache"].map((name) => join(dir, "node_modules", name)),
);
const targets = [
  ".artifacts",
  ".jscpd",
  ".playwright",
  "coverage",
  "playwright-report",
  "test-results",
  ...workspaces.flatMap((dir) => [join(dir, "dist"), join(dir, ".output"), join(dir, ".wxt")]),
  ...caches,
];

for (const target of targets) {
  rmSync(join(root, target), { recursive: true, force: true });
}
console.log(`Removed ${targets.length} paths if present. Dependencies in node_modules are kept.`);
