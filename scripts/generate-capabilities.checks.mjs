import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  canonicalHash,
  checkCapabilities,
  renderCapabilities,
  SOURCE,
  TARGET,
} from "./generate-capabilities.mjs";

const capabilities = {
  chrome: { version: "Google Chrome 156.0.8078.79" },
  extensionLoad: { method: "cdp-load-unpacked" },
  debuggerProbe: {
    date: "2026-11-02",
    samples: 3,
    permissions: ["storage", "debugger"],
    hostPermissions: [],
  },
  debugger: {
    "get-targets-dedicated-worker": {
      description: "getTargets() lists the dedicated worker",
      status: "allowed",
      statuses: ["allowed", "allowed", "allowed"],
      details: [{ type: "other" }, { type: "other" }, { type: "other" }],
    },
    "attach-dedicated-worker": {
      description: "attach to the dedicated worker",
      status: "allowed",
      statuses: ["allowed", "allowed", "allowed"],
      details: [{ targetId: "A" }, { targetId: "B" }, { targetId: "C" }],
    },
    "service-worker-enable": {
      description: "ServiceWorker.enable on the tab session",
      status: "rejected",
      statuses: ["rejected", "rejected", "rejected"],
      error: '{"code":-32601,"message":"\'ServiceWorker.enable\' wasn\'t found"}',
    },
    "auto-attach-service-worker": {
      description: "auto-attach reports | the service worker",
      status: "rejected",
      statuses: ["allowed", "rejected", "allowed"],
      error: "inconsistent",
    },
  },
};
const text = `${JSON.stringify(capabilities, null, 2)}\n`;

function tree(context, files) {
  const root = mkdtempSync(join(tmpdir(), "recnrun-capabilities-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test("renders the Chrome version, date, load method, and permissions", () => {
  const markdown = renderCapabilities(text);
  assert.match(markdown, /^# Chrome capabilities\n/);
  assert.match(markdown, /\| Chrome +\| Google Chrome 156\.0\.8078\.79 +\|/);
  assert.match(markdown, /\| Probed on .*\| 2026-11-02 /);
  assert.match(markdown, /\| `cdp-load-unpacked` /);
  assert.match(markdown, /\| Host permissions .*\| none /);
});

test("renders one row per probe with its status and exact error, escaping pipes", () => {
  const rows = renderCapabilities(text)
    .split("\n")
    .filter((line) => line.startsWith("| `"));
  assert.equal(rows.length, 4);
  assert.match(
    rows[0],
    /`get-targets-dedicated-worker` .*\| allowed .*\| 3 .*\| `\{"type":"other"\}` +\|$/,
  );
  assert.match(
    rows[2],
    /\| rejected .*`\{"code":-32601,"message":"'ServiceWorker\.enable' wasn't found"\}`/,
  );
  assert.match(
    rows[3],
    /reports \\\| the service worker .*\| rejected \(allowed, rejected, allowed\) /,
  );
});

test("shows the first sample's detail and says when later samples differ", () => {
  const row = renderCapabilities(text)
    .split("\n")
    .find((line) => line.startsWith("| `attach-dedicated-worker`"));
  assert.match(row, /\| `\{"targetId":"A"\}` \(samples differ\) +\|$/);
});

test("pads every table row to the same width, as the formatter does", () => {
  const tables = renderCapabilities(text)
    .split("\n\n")
    .filter((block) => block.startsWith("|"));
  assert.equal(tables.length, 2);
  for (const block of tables) {
    const widths = new Set(block.split("\n").map((line) => line.length));
    assert.equal(widths.size, 1, block);
  }
});

test("hashes the JSON without its formatting", () => {
  const compact = JSON.stringify(capabilities);
  assert.equal(canonicalHash(text), canonicalHash(compact));
  assert.match(renderCapabilities(text), new RegExp(`\`${canonicalHash(compact)}\`\\.\n$`));
});

test("the docs check passes when the committed file is current and reports it when stale", (context) => {
  assert.deepEqual(checkCapabilities({ root: tree(context, {}) }), []);
  const current = tree(context, { [SOURCE]: text, [TARGET]: renderCapabilities(text) });
  assert.deepEqual(checkCapabilities({ root: current }), []);
  const stale = tree(context, { [SOURCE]: text, [TARGET]: "# Chrome capabilities\n" });
  assert.deepEqual(checkCapabilities({ root: stale }), [
    "docs/poc/namespace-sessions/CAPABILITIES.md:1: stale; run `node scripts/generate-capabilities.mjs docs/poc/namespace-sessions/capabilities.json`",
  ]);
  const missing = tree(context, { [SOURCE]: text });
  assert.equal(checkCapabilities({ root: missing }).length, 1);
});
