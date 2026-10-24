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
  const excludes = manifest.content_scripts.flatMap((script) => script.exclude_matches);
  assert.deepEqual(excludes, ["https://recnrun.com/privacy/*"]);
  assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1/);
});

test("only the RECnRun site may frame the dashboard and the session page", () => {
  const manifest = productionManifest();
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["dashboard.html", "session.html"],
      matches: ["https://recnrun.com/*"],
      use_dynamic_url: false,
    },
  ]);
});

test("the production build requests only storage and tabs", () => {
  const manifest = productionManifest();
  assert.deepEqual(manifest.permissions, ["storage", "tabs"]);
  assert.equal(manifest.commands, undefined);
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test("the production build ships the logo as its icons", () => {
  const manifest = productionManifest();
  assert.deepEqual(Object.keys(manifest.icons ?? {}), ["16", "32", "48", "128"]);
  for (const icon of Object.values(manifest.icons)) {
    assert.ok(existsSync(new URL(`../.output/chrome-mv3/${icon}`, import.meta.url)), icon);
  }
});
