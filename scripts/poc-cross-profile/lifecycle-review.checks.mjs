import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { shells } from "./lab.mjs";
import { life, scene } from "./lifecycle-lab.mjs";

const EX_REFUSED = 65;

for (const shell of shells) {
  await test(`${shell}: a counter that is not canonical decimal is refused before any effect`, (context) => {
    const { state, request, launches, stateFile } = scene(context);
    mkdirSync(join(state, "profiles"));
    for (const bad of [
      "attempts=08",
      "pid=0",
      "pid=08",
      "startedAt=007",
      "nextAt=1e3",
      "attempts=6",
    ]) {
      writeFileSync(stateFile(), `${bad}\n`);
      const refused = request(shell);
      assert.equal(refused.code, EX_REFUSED, `${bad}: ${refused.err}`);
      assert.match(refused.err, /state file .*: invalid/, bad);
      // The maximum belongs to request; status has none to compare with.
      if (bad !== "attempts=6")
        assert.equal(life(shell, ["status", state], {}).code, EX_REFUSED, bad);
      assert.equal(readFileSync(stateFile(), "utf8"), `${bad}\n`, `${bad} was rewritten`);
    }
    assert.equal(launches(), 0);
  });

  await test(`${shell}: a lock that names zero or a leading-zero number is refused`, (context) => {
    const { state, vars } = scene(context);
    for (const bad of ["0", "08", "-1"]) {
      writeFileSync(join(state, "launcher.lock"), `${bad}\n`);
      const refused = life(shell, ["lock", state], vars());
      assert.equal(refused.code, EX_REFUSED, `${bad}: ${refused.err}`);
      assert.match(refused.err, /does not name a pid/);
    }
  });
}
