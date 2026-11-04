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

await test("the image filters the container's egress to lo before it runs the task", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile.tests"), "utf8");
  assert.match(dockerfile, /apt-get install[^\n]*\biptables\b/);
  const entry = readFileSync(join(root, "scripts/test-container-entry.sh"), "utf8");
  const task = entry.indexOf("exec xvfb-run");
  for (const tool of ["iptables", "ip6tables"]) {
    const accept = entry.search(new RegExp(`^${tool} -A OUTPUT -o lo -j ACCEPT$`, "m"));
    const reject = entry.search(new RegExp(`^${tool} -A OUTPUT -j REJECT\\b`, "m"));
    assert.ok(accept > 0, `${tool} accepts what leaves on lo`);
    assert.ok(reject > accept, `${tool} rejects everything else after the lo rule`);
    assert.ok(reject < task, `${tool} filters before the task`);
  }
  const accepts = entry.match(/^ip6?tables -A OUTPUT .*-j ACCEPT$/gm);
  assert.deepEqual(accepts, [
    "iptables -A OUTPUT -o lo -j ACCEPT",
    "iptables -A OUTPUT -o eth0 -d 224.0.0.251 -p udp --dport 5353 -j ACCEPT",
    "ip6tables -A OUTPUT -o lo -j ACCEPT",
  ]);
  const drop = entry.indexOf("tc filter add dev eth0 egress matchall action drop");
  assert.ok(
    drop > entry.indexOf("tc qdisc add dev eth0 clsact"),
    "eth0 drops every frame it sends",
  );
  assert.ok(drop < task, "eth0 drops before the task");
});
