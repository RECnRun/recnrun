import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { parseVendorManifest } from "../src/index.ts";

const root = join(import.meta.dirname, "..", "vendor", "splitsession");
const manifest = parseVendorManifest(readFileSync(join(root, "vendor-manifest.json"), "utf8"));
const paths = Object.keys(manifest.files);

describe("vendored SplitSession sources", () => {
  test("pin the upstream commit", () => {
    expect(manifest.commit).toBe("475afe88cd1ec7208b2a5510759036955032e0d4");
  });

  test("list at least one file", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  test.each(paths)("%s exists and matches its recorded SHA-256", (path) => {
    const file = join(root, path);
    expect(existsSync(file), `${path} is listed in the manifest but missing`).toBe(true);
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(actual).toBe(manifest.files[path]);
  });

  test("ship the MIT license named by the manifest", () => {
    const file = join(root, manifest.license);
    expect(existsSync(file), "license file is missing").toBe(true);
    expect(readFileSync(file, "utf8").startsWith("MIT License")).toBe(true);
  });

  test("ship a NOTICE that names every vendored file", () => {
    const notice = readFileSync(join(root, "NOTICE"), "utf8");
    for (const path of paths) expect(notice).toContain(path);
  });
});
