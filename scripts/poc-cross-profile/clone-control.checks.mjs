import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, shells } from "./lab.mjs";
import { MASTER } from "./clone-open-lab.mjs";
import { alive, life } from "./lifecycle-lab.mjs";
import { CLONE, OTHER, REQUEST, controlScene, requestText } from "./clone-control-lab.mjs";

const MINUTE = 60_000;
const UNKNOWN = "77777777-7777-4777-8777-777777777777";
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Opens the clone through the lifecycle, as the launcher's loop would, so its state records the pid. */
const open = (shell, s, mode) => {
  const opened = s.request(shell, {}, CLONE, mode);
  assert.equal(opened.code, 0, opened.err);
};
const untouched = (s, before = 0, id = REQUEST) => {
  assert.equal(s.launches(), before);
  assert.deepEqual(s.signals(), []);
  assert.equal(s.status(id).state, "refused", s.status(id).raw);
};

for (const shell of shells) {
  await test(`${shell}: resume and reset of a profile with no state leave a state that reads`, (context) => {
    const s = controlScene(context);
    for (const command of ["resume", "reset"]) {
      assert.equal(life(shell, [command, s.state, CLONE], s.vars()).code, 0, command);
      assert.equal(s.request(shell, {}, CLONE, "headed").code, 0, `${command} poisoned the state`);
      assert.equal(life(shell, ["stop", s.state, CLONE], s.vars()).code, 0);
      rmSync(s.stateFile(CLONE));
    }
  });

  await test(`${shell}: close signals the clone with SIGINT and holds it closed`, (context) => {
    const s = controlScene(context);
    open(shell, s, "headed");
    const pid = Number(s.field("pid", CLONE));
    s.write({ action: "close" });
    const ran = s.run(shell);
    assert.equal(ran.code, 0, ran.err);
    assert.equal(s.status().state, "done", s.status().raw);
    assert.deepEqual(s.signals(), ["int"]);
    assert.equal(alive(pid), false);
    assert.equal(s.field("status", CLONE), "stopped");
    assert.equal(s.request(shell, {}, CLONE, "headed").code, 73);
  });

  await test(`${shell}: close of a closed clone is done and still holds it`, (context) => {
    const s = controlScene(context);
    s.write({ action: "close" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "done");
    assert.match(s.status().message, /already closed/);
    assert.equal(s.request(shell, {}, CLONE, "headed").code, 73);
  });

  await test(`${shell}: open-visible launches headed and open-headless launches headless`, (context) => {
    const s = controlScene(context);
    s.write({ action: "open-headless" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "done", s.status().raw);
    assert.equal(s.launches(), 1);
    assert.equal(s.field("mode", CLONE), "headless");
    const again = controlScene(context);
    again.write({ action: "open-visible" });
    assert.equal(again.run(shell).code, 0);
    assert.equal(again.status().state, "done", again.status().raw);
    assert.equal(again.field("mode", CLONE), "headed");
  });

  await test(`${shell}: an open held closed by a close is opened again by the dashboard`, (context) => {
    const s = controlScene(context);
    s.write({ action: "close" });
    assert.equal(s.run(shell).code, 0);
    s.write({ action: "open-visible" }, SECOND);
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status(SECOND).state, "done", s.status(SECOND).raw);
    assert.equal(s.launches(), 1);
  });

  await test(`${shell}: open in the other mode is refused and signals nothing`, (context) => {
    const s = controlScene(context);
    s.holdClone("headless");
    const before = s.launches();
    s.write({ action: "open-visible" });
    const ran = s.run(shell);
    assert.equal(ran.code, 0, ran.err);
    untouched(s, before);
    assert.match(s.status().message, /already runs headless; close it before opening it visible/);
  });

  await test(`${shell}: open in the mode that already runs is done without a launch`, (context) => {
    const s = controlScene(context);
    s.holdClone("headless");
    const before = s.launches();
    s.write({ action: "open-headless" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "done");
    assert.match(s.status().message, /already open headless/);
    assert.equal(s.launches(), before);
  });

  await test(`${shell}: reopen-visible closes a headless clone and opens it headed`, (context) => {
    const s = controlScene(context);
    open(shell, s, "headless");
    const pid = Number(s.field("pid", CLONE));
    s.write({ action: "reopen-visible" });
    const ran = s.run(shell);
    assert.equal(ran.code, 0, ran.err);
    assert.equal(s.status().state, "done", s.status().raw);
    assert.deepEqual(s.signals(), ["int"]);
    assert.equal(alive(pid), false);
    assert.equal(s.launches(), 2);
    assert.equal(s.field("mode", CLONE), "headed");
  });

  await test(`${shell}: reopen on a closed clone just opens it`, (context) => {
    const s = controlScene(context);
    s.write({ action: "reopen-headless" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.status().state, "done", s.status().raw);
    assert.deepEqual(s.signals(), []);
    assert.equal(s.launches(), 1);
    assert.equal(s.field("mode", CLONE), "headless");
  });

  await test(`${shell}: a deaf Chrome that outlives the wait is an error, never signalled harder`, (context) => {
    const s = controlScene(context, { STUB_DEAF: "1" });
    open(shell, s, "headed");
    s.write({ action: "close" });
    const ran = s.run(shell, { RECNRUN_LIFECYCLE_STOP_S: "1" });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(s.status().state, "error", s.status().raw);
    assert.match(s.status().message, /still runs after 1 s/);
    assert.deepEqual(s.signals(), []);
  });

  const refusals = {
    "an action outside the grammar": { action: "restart" },
    "another namespace": { namespace: "lab-2" },
    "another master": { masterProfileId: ALICE },
    "a stale request": { createdAt: Date.now() - 11 * MINUTE },
    "a request from the future": { createdAt: Date.now() + MINUTE },
    "the master as target": { instanceId: MASTER },
    "a profile the record does not name": { instanceId: UNKNOWN },
    "a clone outside a clones folder": { instanceId: OTHER },
  };
  for (const [name, overrides] of Object.entries(refusals)) {
    await test(`${shell}: ${name} is refused with a status and does nothing`, (context) => {
      const s = controlScene(context);
      open(shell, s, "headed");
      const before = s.launches();
      s.write({ action: "close", ...overrides });
      assert.equal(s.run(shell).code, 0);
      assert.equal(s.status().state, "refused", s.status().raw);
      assert.equal(s.launches(), before);
      assert.deepEqual(s.signals(), []);
    });
  }

  await test(`${shell}: an extra key or a changed key order is refused`, (context) => {
    const s = controlScene(context);
    const text = requestText({ action: "close" }).replace('"kind"', '"extra":1,"kind"');
    mkdirSync(s.folder(), { recursive: true });
    writeFileSync(join(s.folder(), "request.json"), text);
    assert.equal(s.run(shell).code, 0);
    untouched(s);
  });

  await test(`${shell}: a marker of another instance is refused`, (context) => {
    const s = controlScene(context);
    writeFileSync(join(s.root, ".recnrun-clone"), "garbage\n");
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    untouched(s);
  });

  const ignored = {
    "a link": (s) => {
      mkdirSync(s.folder(), { recursive: true });
      writeFileSync(join(s.home, "real.json"), requestText());
      symlinkSync(join(s.home, "real.json"), join(s.folder(), "request.json"));
    },
    "a file over 4096 bytes": (s) => {
      mkdirSync(s.folder(), { recursive: true });
      writeFileSync(join(s.folder(), "request.json"), requestText() + " ".repeat(5000));
    },
    "a NUL byte": (s) => {
      mkdirSync(s.folder(), { recursive: true });
      writeFileSync(join(s.folder(), "request.json"), `${requestText()}\0`);
    },
    "a folder that is a link": (s) => {
      mkdirSync(join(s.home, "elsewhere"));
      writeFileSync(join(s.home, "elsewhere/request.json"), requestText());
      symlinkSync(join(s.home, "elsewhere"), s.folder());
    },
    "a folder not named by a v4 uuid": (s) => {
      mkdirSync(join(s.control, "not-a-uuid"));
      writeFileSync(join(s.control, "not-a-uuid/request.json"), requestText());
    },
  };
  for (const [name, make] of Object.entries(ignored)) {
    await test(`${shell}: ${name} is ignored with no status`, (context) => {
      const s = controlScene(context);
      make(s);
      assert.equal(s.run(shell).code, 0);
      assert.equal(s.hasStatus(), false);
      assert.equal(existsSync(join(s.control, "not-a-uuid/status.json")), false);
      assert.equal(s.launches(), 0);
      assert.deepEqual(s.signals(), []);
    });
  }

  await test(`${shell}: a handled request is not run again`, (context) => {
    const s = controlScene(context);
    s.write({ action: "open-visible" });
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.launches(), 1);
    assert.equal(s.run(shell).code, 0);
    assert.equal(s.launches(), 1);
    assert.equal(s.status().state, "done");
  });

  await test(`${shell}: clones.json lists the worker clones with state and mode, not the master or a stray`, (context) => {
    const s = controlScene(context);
    assert.equal(s.run(shell).code, 0);
    const closed = s.clones();
    assert.deepEqual(
      closed.clones.map(({ name, instanceId, state, mode }) => ({ name, instanceId, state, mode })),
      [{ name: "w1", instanceId: CLONE, state: "closed", mode: "" }],
    );
    s.holdClone("headless");
    assert.equal(s.run(shell).code, 0);
    const running = s.clones().clones[0];
    assert.equal(running.state, "open");
    assert.equal(running.mode, "headless");
    assert.match(s.clones().raw, /"updatedAt":\d+000\}$/);
  });
}
