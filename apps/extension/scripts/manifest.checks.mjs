import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../.output/chrome-mv3/manifest.json", import.meta.url));

const testManifestPath = fileURLToPath(
  new URL("../.output/chrome-mv3-test/manifest.json", import.meta.url),
);

function productionManifest() {
  assert.ok(existsSync(manifestPath), "Build the extension first: vp run extension#build");
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function testManifest() {
  assert.ok(
    existsSync(testManifestPath),
    "Build the test extension first: vp run extension#build:test",
  );
  return JSON.parse(readFileSync(testManifestPath, "utf8"));
}

await test("the production build talks only to the RECnRun domains", () => {
  const manifest = productionManifest();
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.deepEqual(matches, ["https://recnrun.com/*"]);
  const excludes = manifest.content_scripts.flatMap((script) => script.exclude_matches);
  assert.deepEqual(excludes, ["https://recnrun.com/privacy/*"]);
  assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1/);
});

await test("the content script runs only in the top frame of a real document", () => {
  for (const script of productionManifest().content_scripts) {
    assert.equal(script.all_frames, undefined);
    assert.equal(script.match_about_blank, undefined);
    assert.equal(script.match_origin_as_fallback, undefined);
  }
});

await test("only the RECnRun site may frame the dashboard and the session page", () => {
  const manifest = productionManifest();
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["dashboard.html", "session.html"],
      matches: ["https://recnrun.com/*"],
      use_dynamic_url: false,
    },
  ]);
});

await test("the production build requests only storage and tabs", () => {
  const manifest = productionManifest();
  assert.deepEqual(manifest.permissions, ["storage", "tabs"]);
  assert.equal(manifest.commands, undefined);
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_security_policy, undefined);
});

await test("one extension context spans normal and incognito windows", () => {
  assert.equal(productionManifest().incognito, "spanning");
});

await test("the production build ships the logo as its icons", () => {
  const manifest = productionManifest();
  assert.deepEqual(Object.keys(manifest.icons ?? {}), ["16", "32", "48", "128"]);
  for (const icon of Object.values(manifest.icons)) {
    assert.ok(existsSync(new URL(`../.output/chrome-mv3/${icon}`, import.meta.url)), icon);
  }
});

await test("the test build adds exactly the Incognito workspace POC permissions", () => {
  const manifest = testManifest();
  assert.deepEqual(manifest.permissions, [
    "storage",
    "tabs",
    "declarativeNetRequest",
    "scripting",
    "cookies",
    "webNavigation",
  ]);
  assert.deepEqual(manifest.host_permissions, ["http://*.localhost/*"]);
  assert.equal(manifest.message_serialization, "structured_clone");
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.incognito, "spanning");
});

await test("the production build keeps the default JSON messaging", () => {
  assert.equal(productionManifest().message_serialization, undefined);
});

await test("only the test build ships the origin agent, registered at run time", () => {
  const agent = "content-scripts/origin-agent.js";
  assert.ok(existsSync(new URL(`../.output/chrome-mv3-test/${agent}`, import.meta.url)), agent);
  assert.ok(!existsSync(new URL(`../.output/chrome-mv3/${agent}`, import.meta.url)), agent);
  const declared = testManifest().content_scripts.flatMap((script) => script.js);
  assert.ok(!declared.includes(agent), "The origin agent is not a manifest content script.");
});
