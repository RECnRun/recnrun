import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocs, checks, slug } from "./check-docs.mjs";

const script = fileURLToPath(new URL("./check-docs.mjs", import.meta.url));
const target = "# Target\n\n## Section one\n\n## Section one\n\n## `vp run` and F0.1: why?\n";

function tree(context, files) {
  const root = mkdtempSync(join(tmpdir(), "recnrun-docs-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries({ "target.md": target, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return { code: result.status, errors: result.stderr.trim().split("\n").filter(Boolean) };
}

test("accepts links to existing files, directories, and headings", (context) => {
  const root = tree(context, {
    "docs/guide.md": [
      "See [the target](../target.md) and [its section](../target.md#section-one).",
      "The [repeat](../target.md#section-one-1), [code heading](../target.md#vp-run-and-f01-why),",
      'and the [folder](./) and an ![image](../target.md "title") resolve.',
    ].join("\n"),
  });
  assert.deepEqual(run(root), { code: 0, errors: [] });
});

test("reports a link to a missing file with its file and line", (context) => {
  const root = tree(context, { "docs/guide.md": "Intro.\n\nRead [this](missing.md) first.\n" });
  assert.deepEqual(run(root), {
    code: 1,
    errors: ["docs/guide.md:3: broken link missing.md: docs/missing.md does not exist"],
  });
});

test("reports an anchor that matches no heading of the target", (context) => {
  const root = tree(context, { "guide.md": "[gone](target.md#section-two)\n" });
  assert.deepEqual(run(root), {
    code: 1,
    errors: [
      "guide.md:1: broken anchor target.md#section-two: target.md has no heading #section-two",
    ],
  });
});

test("ignores external links, bare anchors, and code", (context) => {
  const root = tree(context, {
    "guide.md": [
      "[site](https://example.com/missing.md) [mail](mailto:hello@recnrun.com) [top](#nowhere)",
      "`[inline](missing.md)`",
      "```md",
      "[fenced](missing.md)",
      "```",
    ].join("\n"),
  });
  assert.deepEqual(run(root), { code: 0, errors: [] });
});

test("skips dependencies and build output", (context) => {
  const root = tree(context, {
    "node_modules/pkg/README.md": "[x](missing.md)",
    "apps/web/dist/notes.md": "[x](missing.md)",
    "coverage/report.md": "[x](missing.md)",
  });
  assert.deepEqual(checkDocs(root), []);
});

test("slugs headings the way GitHub does", () => {
  assert.equal(
    slug("6. Security tests (cross-cutting, source §17 and §19)"),
    "6-security-tests-cross-cutting-source-17-and-19",
  );
  assert.equal(slug("F4: Editor, parameters, import/export"), "f4-editor-parameters-importexport");
});

test("keeps an extension point for later documentation checks", () => {
  assert.ok(checks.length >= 1);
  assert.ok(checks.every((check) => typeof check === "function"));
});
