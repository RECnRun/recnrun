import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

await test("the image adds an on-link default route before it runs the task", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile.tests"), "utf8");
  assert.match(dockerfile, /apt-get install[^\n]*\biproute2\b/);
  const [, entrypoint] = dockerfile.match(/^ENTRYPOINT (.+)$/m);
  assert.deepEqual(JSON.parse(entrypoint), ["sh", "/workspace/scripts/test-container-entry.sh"]);
  const entry = readFileSync(join(root, "scripts/test-container-entry.sh"), "utf8");
  const route = entry.indexOf("ip route add default dev eth0");
  assert.ok(route > 0, "the entry step adds the default route");
  assert.ok(route < entry.indexOf("exec xvfb-run"), "the route comes before the task");
  assert.match(entry, /exec xvfb-run -a .* vp run --no-cache "\$@"/);
});
