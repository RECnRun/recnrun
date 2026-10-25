import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function hookScripts(config) {
  const text = readFileSync(`${root}${config}`, "utf8");
  return [...text.matchAll(/scripts\/agent-hooks\/[\w.-]+\.mjs/g)]
    .map(([path]) => path)
    .sort((a, b) => a.localeCompare(b));
}

await test("Codex and Claude Code run the same existing hook scripts", () => {
  const codex = hookScripts(".codex/hooks.json");
  assert.deepEqual(codex, ["scripts/agent-hooks/pre-tool-use.mjs", "scripts/agent-hooks/stop.mjs"]);
  assert.deepEqual(hookScripts(".claude/settings.json"), codex);
  for (const script of codex) assert.ok(existsSync(`${root}${script}`), script);
});
