import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { POC_PUBLIC_KEY } from "./poc-key.mjs";

const BASE = ["storage", "tabs", "offscreen", "downloads"];
const VARIANTS = {
  "poc-d0": BASE,
  "poc-d1": [...BASE, "debugger"],
  "poc-d2": [...BASE, "debugger"],
};

function outputDir(mode) {
  return fileURLToPath(new URL(`../.output/chrome-mv3-${mode}/`, import.meta.url));
}

function pocManifest(mode) {
  const path = `${outputDir(mode)}manifest.json`;
  assert.ok(existsSync(path), `Build the POC variants first: vp run build:poc (missing ${mode})`);
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const [mode, permissions] of Object.entries(VARIANTS)) {
  await test(`${mode} declares its permissions, the pinned key, and the POC pages`, () => {
    const manifest = pocManifest(mode);
    assert.deepEqual(manifest.permissions, permissions);
    assert.equal(manifest.key, POC_PUBLIC_KEY);
    // MV3 reads file:// from an extension page only with this host permission and the toggle (E1).
    assert.deepEqual(manifest.host_permissions, ["file:///*"]);
    for (const page of ["diagnostics.html", "offscreen.html"]) {
      assert.ok(existsSync(`${outputDir(mode)}${page}`), `${mode} lacks ${page}`);
    }
    const matches = manifest.content_scripts.flatMap((script) => script.matches);
    assert.ok(matches.includes("http://localhost/*"), `${mode} does not match localhost`);
  });
}
