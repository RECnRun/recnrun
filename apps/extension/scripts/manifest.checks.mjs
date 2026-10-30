import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../.output/chrome-mv3/manifest.json", import.meta.url));

function productionManifest() {
  assert.ok(existsSync(manifestPath), "Build the extension first: vp run extension#build");
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

test("the production build talks only to the RECnRun domains", () => {
  const manifest = productionManifest();
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.deepEqual(matches, ["https://recnrun.com/*"]);
  assert.deepEqual(manifest.externally_connectable, { matches: ["https://recnrun.com/*"] });
  assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1/);
});

test("the production build asks for site access only at run time", () => {
  const manifest = productionManifest();
  assert.deepEqual(manifest.permissions, ["storage", "scripting", "tabs", "tabGroups"]);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.host_permissions, undefined);
});

test("the production build keeps the extension id stable through its key", () => {
  const manifest = productionManifest();
  assert.match(manifest.key ?? "", /^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA/);
});

test("the production build ships the logo as its icons", () => {
  const manifest = productionManifest();
  assert.deepEqual(Object.keys(manifest.icons ?? {}), ["16", "32", "48", "128"]);
  for (const icon of Object.values(manifest.icons)) {
    assert.ok(existsSync(new URL(`../.output/chrome-mv3/${icon}`, import.meta.url)), icon);
  }
});
