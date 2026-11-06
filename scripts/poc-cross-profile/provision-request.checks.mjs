import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALICE, shells } from "./lab.mjs";
import { provisionScene, requestText, shape } from "./provision-lab.mjs";

const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

for (const shell of shells) {
  await test(`${shell}: run ignores what it cannot trust and answers a refusable request`, (context) => {
    const s = provisionScene(context);
    mkdirSync(join(s.ops, "not-a-uuid"));
    writeFileSync(join(s.ops, "not-a-uuid/request.json"), requestText({ basesDir: s.bases }));
    s.request({}, OTHER);
    writeFileSync(
      join(s.folder(OTHER), "request.json"),
      `${requestText({ basesDir: s.bases })}${" ".repeat(4100)}`,
    );
    const linked = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mkdirSync(s.folder(linked));
    writeFileSync(
      join(s.home, "elsewhere.json"),
      requestText({ operationId: linked, basesDir: s.bases }),
    );
    symlinkSync(join(s.home, "elsewhere.json"), join(s.folder(linked), "request.json"));
    const folderLink = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    mkdirSync(join(s.home, "real-op"));
    writeFileSync(
      join(s.home, "real-op/request.json"),
      requestText({ operationId: folderLink, basesDir: s.bases }),
    );
    symlinkSync(join(s.home, "real-op"), s.folder(folderLink));
    const result = s.run(shell);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(readdirSync(join(s.state, "ops")), []);
    for (const id of [OTHER, linked]) assert.equal(s.hasStatus(id), false, id);
    assert.equal(existsSync(join(s.home, "real-op/status.json")), false);
    assert.equal(s.launchCount(), 0);
    assert.match(result.err, /ignored/);
  });

  await test(`${shell}: run answers a request with a bad value and starts nothing`, (context) => {
    const s = provisionScene(context);
    const cases = [
      [{ basesDir: "../x" }, /basesDir/],
      [{ basesDir: "relative" }, /basesDir/],
      [{ basesDir: "/Users/me/My Bases" }, /basesDir/],
      [{ basesDir: "/Users/me/bases/" }, /basesDir/],
      [{ basesDir: "/Users//bases" }, /basesDir/],
      [{ basesDir: "/Users/./bases" }, /basesDir/],
      [{ basesDir: "/Users/bases/." }, /basesDir/],
      [{ clones: 0 }, /clones/],
      [{ clones: 9 }, /clones/],
      [{ baseName: "base-vx" }, /closed grammar/],
      [{ namespace: "other-1" }, /closed grammar/],
      [{ masterProfileId: ALICE }, /closed grammar/],
      [{ kind: "prepare" }, /closed grammar/],
    ];
    for (const [overrides, pattern] of cases) {
      rmSync(s.folder(), { recursive: true, force: true });
      rmSync(join(s.state, "ops"), { recursive: true, force: true });
      s.request(overrides);
      assert.equal(s.run(shell).code, 0);
      const status = shape(s.status());
      assert.deepEqual(
        [status.step, status.state],
        ["create-base", "error"],
        JSON.stringify(overrides),
      );
      assert.match(status.message, pattern);
      assert.match(status.message, /^refused: /);
    }
    for (const count of ["01", "+2", "00", "10", "2.0"]) {
      rmSync(s.folder(), { recursive: true, force: true });
      rmSync(join(s.state, "ops"), { recursive: true, force: true });
      s.request();
      const file = join(s.folder(), "request.json");
      writeFileSync(file, readFileSync(file, "utf8").replace('"clones":2,', `"clones":${count},`));
      s.run(shell);
      const refused = shape(s.status());
      assert.equal(refused.state, "error", count);
      assert.match(refused.message, /clones/, count);
    }
    rmSync(s.folder(), { recursive: true, force: true });
    rmSync(join(s.state, "ops"), { recursive: true, force: true });
    mkdirSync(s.folder());
    writeFileSync(join(s.folder(), "request.json"), `${requestText({ basesDir: s.bases })} `);
    s.run(shell);
    assert.equal(shape(s.status()).state, "error", "a byte after the closing brace");
    assert.equal(s.launchCount(), 0);
  });

  await test(`${shell}: run creates a missing bases folder under the home and takes a blank one as ~/RECnRun/bases`, (context) => {
    const s = provisionScene(context);
    rmSync(s.bases, { recursive: true });
    const first = (overrides) => {
      rmSync(join(s.state, "ops"), { recursive: true, force: true });
      s.request(overrides);
      assert.equal(s.run(shell).code, 0);
      return shape(s.status());
    };
    const blank = first({ basesDir: "" });
    assert.deepEqual(
      [blank.step, blank.state, blank.message],
      ["create-base", "running", "created base-v1"],
    );
    assert.equal(
      existsSync(join(s.home, "RECnRun/bases/base-v1/Default")),
      true,
      "the default folder",
    );
    const nested = join(s.home, "deep/new/bases");
    const explicit = first({ basesDir: nested });
    assert.equal(explicit.state, "running", explicit.message);
    assert.equal(existsSync(join(nested, "base-v1/Default")), true, "a missing folder is created");
  });

  await test(`${shell}: run refuses to create a bases folder outside the home or through a link`, (context) => {
    const s = provisionScene(context);
    mkdirSync(join(s.home, "real"));
    symlinkSync(join(s.home, "real"), join(s.home, "link"));
    for (const basesDir of ["/recnrun-no-such-root/bases", join(s.home, "link/bases")]) {
      rmSync(join(s.state, "ops"), { recursive: true, force: true });
      s.request({ basesDir });
      assert.equal(s.run(shell).code, 0);
      const status = shape(s.status());
      assert.deepEqual([status.step, status.state], ["create-base", "error"], basesDir);
    }
    assert.equal(existsSync(join(s.home, "real/bases")), false);
    assert.equal(existsSync("/recnrun-no-such-root"), false);
    assert.equal(s.launchCount(), 0);
  });
}
