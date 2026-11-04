import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { POC_EXTENSION_ID, POC_PUBLIC_KEY } from "./poc-key.mjs";

const BASE = ["storage", "tabs", "offscreen", "downloads"];
const VARIANTS = {
  "poc-d0": BASE,
  "poc-d1": [...BASE, "debugger"],
  "poc-d2": [...BASE, "debugger"],
};

/** Chrome's id of a `key`: the first 16 bytes of the SHA-256 of the DER key, each nibble as a-p. */
function extensionIdOf(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  const letter = (nibble) => String.fromCharCode(97 + parseInt(nibble, 16));
  return Array.from(digest.slice(0, 32), letter).join("");
}

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
    assert.equal(extensionIdOf(manifest.key), POC_EXTENSION_ID);
    // MV3 reads file:// from an extension page only with this host permission and the toggle (E1).
    assert.deepEqual(manifest.host_permissions, ["file:///*"]);
    for (const page of ["diagnostics.html", "offscreen.html"]) {
      assert.ok(existsSync(`${outputDir(mode)}${page}`), `${mode} lacks ${page}`);
    }
    const matches = manifest.content_scripts.flatMap((script) => script.matches);
    assert.ok(matches.includes("http://localhost/*"), `${mode} does not match localhost`);
  });
}

/** A built script with every chunk it imports, since WXT moves shared code into hashed chunks. */
function withChunks(mode, file, seen = new Set()) {
  if (seen.has(file)) return "";
  seen.add(file);
  const code = readFileSync(`${outputDir(mode)}${file}`, "utf8");
  const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const chunks = [...code.matchAll(/from\s*"\.\/([^"]+)"/g)].map((match) => base + match[1]);
  return [code, ...chunks.map((chunk) => withChunks(mode, chunk, seen))].join("\n");
}

/** The code an extension page runs: its module script and the chunks that one imports. */
function pageScript(mode, page) {
  const html = readFileSync(`${outputDir(mode)}${page}`, "utf8");
  const src = /<script[^>]+src="\/?([^"]+)"/.exec(html)?.[1];
  assert.ok(src, `${mode} ${page} loads no script`);
  return withChunks(mode, src);
}

for (const mode of Object.keys(VARIANTS)) {
  await test(`${mode} reads file:// in the offscreen document through the background (E3)`, () => {
    assert.match(readFileSync(`${outputDir(mode)}background.js`, "utf8"), /POC_READ_FILE/);
    assert.match(pageScript(mode, "offscreen.html"), /POC_READ_FILE/);
    assert.match(pageScript(mode, "diagnostics.html"), /POC_READ_FILE/);
  });

  await test(`${mode} starts the mesh in the background and the pairing UI in the dashboard`, () => {
    // Strings only the cross-profile mesh carries; the file:// relay alone also calls createDocument.
    assert.match(withChunks(mode, "background.js"), /The other profile is not connected\./);
    assert.match(pageScript(mode, "dashboard.html"), /This profile controls no session in another/);
  });

  await test(`${mode} has no content script that matches file:// (POC §4)`, () => {
    const matches = pocManifest(mode).content_scripts.flatMap((script) => script.matches);
    assert.ok(!matches.some((pattern) => /^(file|\*):/.test(pattern)), matches.join(", "));
  });
}
