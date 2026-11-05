import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POC_PUBLIC_KEY } from "../../apps/extension/scripts/poc-key.mjs";
import { buildPackage } from "./package/build.mjs";

/* The fixtures of the package checks: a stand-in POC build, a built package, and a bare PATH. */

const PERMISSIONS = ["storage", "tabs", "offscreen", "downloads", "alarms"];
// What the launcher scripts call besides the shell's builtins; the checks prove the list is enough.
const UTILITIES =
  "cat cut date dirname grep head ln mkdir mv od ps rm sed sleep sort tail tr uname wc";

/** A temporary folder removed when the test context ends. */
export function scratch(context) {
  const directory = mkdtempSync(join(tmpdir(), "recnrun-package-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A folder shaped like the poc-d0 build; `manifest` overrides keys of its manifest.json. */
export function fakeBuild(directory, manifest = {}) {
  const build = join(directory, "build");
  mkdirSync(join(build, "chunks"), { recursive: true });
  const text = { key: POC_PUBLIC_KEY, permissions: PERMISSIONS, name: "RECnRun", ...manifest };
  writeFileSync(join(build, "manifest.json"), JSON.stringify(text));
  for (const page of ["diagnostics.html", "bootstrap.html"])
    writeFileSync(join(build, page), "<!doctype html>");
  writeFileSync(join(build, "background.js"), "// stand-in\n");
  writeFileSync(join(build, "chunks/storage-abc.js"), "// stand-in\n");
  return build;
}

/** The package of a stand-in build: { macos, linux } folders under the scratch directory. */
export function builtPackage(directory) {
  const [macos, linux] = buildPackage({
    extension: fakeBuild(directory),
    out: join(directory, "out"),
  });
  return { macos, linux };
}

/** A bin folder holding `sh` and the utilities of UTILITIES taken from the current PATH, nothing else. */
export function bareBin(directory) {
  const bin = join(directory, "bare-bin");
  mkdirSync(bin);
  for (const name of ["sh", ...UTILITIES.split(" ")]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (found.startsWith("/")) symlinkSync(found, join(bin, name));
  }
  return bin;
}
