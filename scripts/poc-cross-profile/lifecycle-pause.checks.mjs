import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, NAMESPACE, shells } from "./lab.mjs";
import { life, scene } from "./lifecycle-lab.mjs";

const EX_REFUSED = 65;
const EX_PAUSED = 73;

for (const shell of shells) {
  await test(`${shell}: an open profile that is alive and silent is left alone, never paused`, (context) => {
    const { request, launches, field } = scene(context);
    assert.equal(request(shell).code, 0);
    const silent = request(shell);
    assert.equal(silent.code, 0, silent.err);
    assert.match(silent.err, /open but silent/);
    assert.equal(field("status"), "open");
    assert.equal(launches(), 1);
  });

  for (const reason of ["disconnect", "forget"]) {
    await test(`${shell}: the ${reason} statement pauses an open profile until resume`, (context) => {
      const { state, request, launches, field, mark } = scene(context);
      assert.equal(request(shell).code, 0);
      const file = mark(reason);
      const held = request(shell);
      assert.equal(held.code, EX_PAUSED, held.err);
      assert.equal(field("status"), "paused");
      assert.match(held.err, new RegExp(`${reason}`));
      assert.equal(request(shell).code, EX_PAUSED);
      assert.equal(launches(), 1);
      const refused = life(shell, ["resume", state, ALICE], {});
      assert.equal(refused.code, EX_REFUSED, refused.err);
      assert.ok(refused.err.includes(file), "the message names the file");
      assert.equal(field("status"), "paused");
      rmSync(file);
      assert.equal(life(shell, ["resume", state, ALICE], {}).code, 0);
      assert.equal(field("status"), "idle");
    });
  }

  await test(`${shell}: the statement wins over a fresh presence`, (context) => {
    const { request, publish, mark } = scene(context);
    assert.equal(request(shell).code, 0);
    publish();
    mark("disconnect");
    assert.equal(request(shell).code, EX_PAUSED);
  });

  await test(`${shell}: a dead pid with the statement is held, not relaunched`, (context) => {
    const { request, launches, field, mark } = scene(context, { STUB_ALIVE: "" });
    assert.equal(request(shell).code, 0);
    mark("disconnect");
    assert.equal(request(shell).code, EX_PAUSED);
    assert.equal(field("status"), "paused");
    assert.equal(launches(), 1);
  });

  await test(`${shell}: a resumed statement pauses nothing, and resume ignores it`, (context) => {
    const { state, request, field, mark } = scene(context);
    assert.equal(request(shell).code, 0);
    mark("resumed");
    assert.equal(request(shell).code, 0);
    assert.equal(field("status"), "open");
    assert.equal(life(shell, ["pause", state, ALICE], {}).code, 0);
    assert.equal(life(shell, ["resume", state, ALICE], {}).code, 0);
    assert.equal(field("status"), "idle");
  });

  const exact = (reason) =>
    `{"profileId":"${ALICE}","reason":"${reason}","identity":{"key":"${"B".repeat(87)}","signedAt":1,"signature":"${"S".repeat(86)}"},"createdAt":1}`;
  const refusals = {
    "a free reason": exact("because I said so"),
    "a reason outside the enumeration": exact("Disconnect"),
    "another profile": exact("disconnect").replace(ALICE, "22222222-2222-4222-8222-222222222222"),
    "a trailing byte": `${exact("disconnect")}\n`,
    "extra keys": exact("disconnect").replace(',"createdAt"', ',"note":"x","createdAt"'),
    "a short key": exact("disconnect").replace("B".repeat(87), "B".repeat(86)),
    "too many bytes": `${exact("disconnect")}${" ".repeat(4096)}`,
  };
  for (const [name, text] of Object.entries(refusals)) {
    await test(`${shell}: a statement with ${name} is ignored and the live profile left alone`, (context) => {
      const { state, request, launches, field, mark } = scene(context);
      assert.equal(request(shell).code, 0);
      mark("disconnect", text);
      const silent = request(shell);
      assert.equal(silent.code, 0, silent.err);
      assert.equal(field("status"), "open");
      assert.equal(launches(), 1);
      assert.equal(life(shell, ["pause", state, ALICE], {}).code, 0);
      assert.equal(
        life(shell, ["resume", state, ALICE], {}).code,
        0,
        "resume does not see it either",
      );
    });
  }

  await test(`${shell}: a statement behind a link is ignored`, (context) => {
    const { home, request, field } = scene(context);
    assert.equal(request(shell).code, 0);
    const elsewhere = join(home, "elsewhere", ALICE);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "paused.json"), exact("disconnect"));
    symlinkSync(join(home, "elsewhere"), join(home, "Downloads/RECnRun/poc", NAMESPACE, "peers"));
    assert.equal(request(shell).code, 0);
    assert.equal(field("status"), "open");
  });
}
