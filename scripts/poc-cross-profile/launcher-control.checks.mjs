import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { NAMESPACE, shells } from "./lab.mjs";
import { launcher } from "./commands-lab.mjs";
import { CLONE, controlScene } from "./clone-control-lab.mjs";

const once = (shell, s) =>
  launcher(shell, ["start", s.state, s.record, NAMESPACE, "--once"], s.vars());

for (const shell of shells) {
  await test(`${shell}: start --once runs clone-control.sh once per pass for the master's requests`, (context) => {
    const s = controlScene(context);
    s.write({ action: "close" });
    const result = once(shell, s);
    assert.equal(result.code, 0, result.err);
    assert.equal(s.status().state, "done", s.status().raw);
    assert.equal(s.field("status", CLONE), "stopped");
    assert.equal(s.clones().clones[0].state, "closed");
  });

  await test(`${shell}: start --once makes the control folder so clones.json can appear`, (context) => {
    const s = controlScene(context);
    rmSync(s.control, { recursive: true });
    const result = once(shell, s);
    assert.equal(result.code, 0, result.err);
    assert.equal(s.clones().clones[0].instanceId, CLONE);
  });
}
