import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, shells } from "./lab.mjs";
import { alive, life, scene } from "./lifecycle-lab.mjs";
import { commandScene, launcher } from "./commands-lab.mjs";

const EX_REFUSED = 65;
const CHROME = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const shell of shells) {
  // The stub ps answers the command line of the profile's pid; the process itself is a live stub Chrome.
  const stopWith = (s, command, extra = {}) => {
    const pid = s.field("pid");
    const vars = s.vars({ RECNRUN_LIFECYCLE_STOP_S: "1", STUB_PS_PID: pid, ...command, ...extra });
    return life(shell, ["stop", s.state, ALICE, ...(extra.force ? ["--force"] : [])], vars);
  };
  const line = (s, root = s.root) => `${join(s.home, CHROME)} --user-data-dir=${root}`;

  await test(`${shell}: stop refuses a command line whose root only starts with the recorded one`, (context) => {
    const s = scene(context);
    assert.equal(s.request(shell).code, 0);
    const pid = Number(s.field("pid"));
    const longer = stopWith(s, {
      STUB_PS_CMD: `${line(s, `${s.root} other`)} --profile-directory=Default`,
    });
    assert.equal(longer.code, EX_REFUSED, longer.err);
    assert.match(longer.err, /does not name/);
    assert.equal(alive(pid), true);
    assert.equal(s.field("status"), "open");
  });

  await test(`${shell}: stop refuses a recycled pid before TERM and before KILL`, (context) => {
    const s = scene(context, { STUB_DEAF: "1" });
    assert.equal(s.request(shell).code, 0);
    const pid = Number(s.field("pid"));
    const other = stopWith(s, { STUB_PS_CMD: "/usr/bin/vim notes.txt" });
    assert.equal(other.code, EX_REFUSED, other.err);
    const notChrome = stopWith(s, {
      STUB_PS_CMD: `/usr/bin/env ${line(s)} --profile-directory=Default`,
    });
    assert.equal(notChrome.code, EX_REFUSED, "the command line must start with Chrome");
    const midway = stopWith(s, { STUB_PS_CMD_AFTER: "/usr/bin/vim notes.txt" }, { force: true });
    assert.equal(midway.code, EX_REFUSED, midway.err);
    assert.equal(alive(pid), true, "no SIGKILL went to the recycled pid");
    assert.equal(s.field("status"), "open");
  });

  await test(`${shell}: the launcher's pid file must name this state directory`, (context) => {
    const s = commandScene(context);
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    s.spawned.push(bystander.pid);
    writeFileSync(join(s.state, "launcher.pid"), `${bystander.pid}\n`);
    const named = (state) => `/bin/sh /x/recnrun-launcher.sh start ${state} ${s.record} lab-1`;
    const ask = (command, ...args) =>
      launcher(
        shell,
        [...args, s.state],
        s.vars({ STUB_PS_PID: String(bystander.pid), STUB_PS_CMD: command }),
      );
    assert.match(ask(named(join(s.home, "elsewhere")), "status").out, /^launcher stopped\n/);
    assert.equal(ask(named(join(s.home, "elsewhere")), "stop").code, 0);
    assert.equal(alive(bystander.pid), true, "another launcher's pid is not signalled");
    assert.match(
      ask(named(s.state), "status").out,
      new RegExp(`^launcher running pid=${bystander.pid}\\n`),
    );
  });
}
