import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const inContainer = process.env.RECNRUN_TEST_CONTAINER === "1";
const available = spawnSync("sh", ["-c", "command -v shellcheck"]).status === 0;
// The image installs ShellCheck; on a Mac without it the checks are skipped, never faked.
const skip = available
  ? false
  : inContainer
    ? undefined
    : "ShellCheck is not installed on this host (brew install shellcheck)";

function shellcheck(files) {
  return spawnSync(
    "shellcheck",
    ["--shell=sh", "--severity=style", "--external-sources", "--source-path=SCRIPTDIR", ...files],
    {
      encoding: "utf8",
    },
  );
}

const labLauncher = fileURLToPath(new URL("../../tests/lab/web-master/launcher/", import.meta.url));
const launcherScripts = [here, labLauncher].flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => join(dir, name)),
);

await test("ShellCheck is in the test image", () => {
  assert.ok(!inContainer || available, "the container must have shellcheck");
});

await test("/bin/sh of the test image is dash", { skip: !inContainer }, () => {
  const { stdout } = spawnSync("readlink", ["-f", "/bin/sh"], { encoding: "utf8" });
  assert.match(stdout.trim(), /\/dash$/);
});

await test("ShellCheck passes every launcher script", { skip }, () => {
  assert.ok(launcherScripts.length > 0, "the package has scripts to lint");
  const result = shellcheck(launcherScripts);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

await test("ShellCheck rejects an unquoted expansion", { skip }, (context) => {
  const directory = mkdtempSync(join(tmpdir(), "recnrun-shellcheck-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bad = join(directory, "bad.sh");
  writeFileSync(bad, "#!/bin/sh\nset -eu\necho $1\n");
  const result = shellcheck([bad]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /SC2086/);
});
