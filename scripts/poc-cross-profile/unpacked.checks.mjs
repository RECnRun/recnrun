import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { shells } from "./lab.mjs";
import { lab, profile, profiles } from "./profiles-lab.mjs";

const EX_NOT_FOUND = 66;
const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";
const DECOY = "abcdefghijklmnopabcdefghijklmnoo";

for (const shell of shells) {
  await test(`${shell}: unpacked_path_of reads the path of the settings entry and only of an unpacked install`, (context) => {
    const { home, env } = lab(context);
    const root = join(home, "Chrome");
    const call = (fn, name, id = EXTENSION) => profiles(shell, [fn, root, name, id], env());
    const entry = (id, body) => `"${id}":{${body}}`;
    profile(root, "Unpacked", {
      Preferences: `{"extensions":{"settings":{${entry(DECOY, '"path":"/other"')},${entry(EXTENSION, '"commands":{},"path":"/builds/poc d0","state":1')}}}}`,
    });
    profile(root, "Secure", {
      Preferences: "{}",
      "Secure Preferences": `{"extensions":{"settings":{${entry(EXTENSION, '"path":"/builds/sec"')}}}}`,
    });
    profile(root, "Relative", {
      Preferences: `{"extensions":{"settings":{${entry(EXTENSION, '"path":"build"')}}}}`,
    });
    profile(root, "Escaped", {
      Preferences: `{"extensions":{"settings":{${entry(EXTENSION, '"path":"/a\\\\b"')}}}}`,
    });
    profile(root, "NoPath", {
      Preferences: `{"extensions":{"settings":{${entry(EXTENSION, '"state":1')},${entry(DECOY, '"path":"/other"')}}}}`,
    });
    profile(root, "Packed", {
      Preferences: `{"extensions":{"settings":{${entry(EXTENSION, '"path":"/x"')}}}}`,
    });
    mkdirSync(join(root, "Packed/Extensions", EXTENSION, "1.0_0"), { recursive: true });
    writeFileSync(join(root, "Packed/Extensions", EXTENSION, "1.0_0/manifest.json"), "{}");
    profile(root, "Absent");
    const path = (name) => [
      call("unpacked_path_of", name).code,
      call("unpacked_path_of", name).out,
    ];
    assert.deepEqual(path("Unpacked"), [0, "/builds/poc d0\n"]);
    assert.deepEqual(path("Secure"), [0, "/builds/sec\n"]);
    assert.deepEqual(path("Relative"), [0, `${root}/Relative/build\n`]);
    for (const name of ["Escaped", "NoPath", "Packed", "Absent", "Missing"])
      assert.deepEqual(path(name), [1, ""], name);
    assert.equal(call("unpacked_path_of", "Unpacked", "bad").code, 64);
    assert.equal(profiles(shell, ["unpacked_path_of", root], env()).code, 64);
  });

  await test(`${shell}: unpacked_code_present needs the folder and its manifest of an unpacked install`, (context) => {
    const { home, env } = lab(context);
    const root = join(home, "Chrome");
    const code = join(home, "build");
    profile(root, "Default", {
      Preferences: `{"extensions":{"settings":{"${EXTENSION}":{"path":"${code}"}}}}`,
    });
    profile(root, "Absent");
    const present = (name = "Default") =>
      profiles(shell, ["unpacked_code_present", root, name, EXTENSION], env());
    const missing = present();
    assert.equal(missing.code, EX_NOT_FOUND, missing.err);
    assert.match(missing.err, new RegExp(`unpacked code missing: ${code}\n`));
    mkdirSync(code);
    assert.equal(present().code, EX_NOT_FOUND, "a folder without manifest.json is no build");
    writeFileSync(join(code, "manifest.json"), "{}");
    assert.deepEqual([present().code, present().err], [0, ""]);
    assert.deepEqual([present("Absent").code, present("Absent").err], [0, ""]);
    assert.equal(profiles(shell, ["unpacked_code_present", root, "Default"], env()).code, 64);
  });
}
