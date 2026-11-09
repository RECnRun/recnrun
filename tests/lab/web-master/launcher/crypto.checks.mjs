import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./launcher-crypto.sh", import.meta.url));
const { subtle } = globalThis.crypto;
const EC = { name: "ECDSA", namedCurve: "P-256" };

function pathOpenssl() {
  const found = spawnSync("sh", ["-c", "command -v openssl"], { encoding: "utf8" }).stdout.trim();
  return found === "" ? [] : [found];
}
// macOS signs with LibreSSL at /usr/bin/openssl; a Homebrew openssl on PATH must agree too.
const binaries = [
  ...new Set([...(process.platform === "darwin" ? ["/usr/bin/openssl"] : []), ...pathOpenssl()]),
];

function call(openssl, fn, ...args) {
  const script = '. "$1"; shift; lab_openssl; "$@"';
  return spawnSync("sh", ["-c", script, "sh", helper, fn, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, RECNRUN_LAB_OPENSSL: openssl },
  });
}

// WebCrypto signs P1363 (r||s); openssl verifies DER, as the site's request signer will send it.
function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.subarray(start);
  const pad = body[0] & 0x80 ? [0] : [];
  return [0x02, body.length + pad.length, ...pad, ...body];
}
function p1363ToDer(signature) {
  const raw = new Uint8Array(signature);
  const seq = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return Buffer.from([0x30, seq.length, ...seq]);
}

async function masterKey(dir) {
  const pair = await subtle.generateKey(EC, true, ["sign", "verify"]);
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  writeFileSync(join(dir, "master.spki"), spki);
  return { pair, spki };
}

for (const openssl of binaries) {
  await test(`launcher crypto with ${openssl}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "launcher-crypto-"));
    const at = (name) => join(dir, name);
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    await t.test("the fingerprint is the SHA-256 of the SPKI bytes", async () => {
      const { spki } = await masterKey(dir);
      const want = Buffer.from(await subtle.digest("SHA-256", spki)).toString("hex");
      const out = call(openssl, "lab_sha256", at("master.spki"));
      assert.equal(out.stdout, `${want}\n`, out.stderr);
      assert.equal(
        call(openssl, "lab_fp_display", want).stdout,
        `${want.slice(0, 20).match(/.{4}/g).join(" ")}\n`,
      );
    });

    await t.test("only a 91-byte P-256 SPKI on the curve is accepted", async () => {
      const { spki } = await masterKey(dir);
      assert.equal(call(openssl, "lab_spki", at("master.spki"), at("master.pem")).status, 0);
      assert.match(readFileSync(at("master.pem"), "utf8"), /BEGIN PUBLIC KEY/);
      const bad = {
        long: Buffer.concat([spki, Buffer.from([0])]),
        prefix: Buffer.from(spki).fill(0x31, 0, 1),
        point: Buffer.concat([spki.subarray(0, 27), Buffer.alloc(64, 0xff)]),
      };
      for (const [name, bytes] of Object.entries(bad)) {
        writeFileSync(at(`${name}.spki`), bytes);
        assert.notEqual(
          call(openssl, "lab_spki", at(`${name}.spki`), at(`${name}.pem`)).status,
          0,
          name,
        );
      }
    });

    await t.test(
      "a DER signature from WebCrypto verifies and a flipped byte does not",
      async () => {
        const { pair } = await masterKey(dir);
        assert.equal(call(openssl, "lab_spki", at("master.spki"), at("master.pem")).status, 0);
        const body = Buffer.from("recnrun-lab-request v1\naction=start\n");
        writeFileSync(at("body"), body);
        const der = p1363ToDer(
          await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, body),
        );
        const good = call(
          openssl,
          "lab_verify",
          at("master.pem"),
          at("body"),
          der.toString("base64"),
        );
        assert.equal(good.status, 0, good.stderr);
        writeFileSync(at("body"), Buffer.from("recnrun-lab-request v1\naction=stop\n"));
        assert.equal(
          call(openssl, "lab_verify", at("master.pem"), at("body"), der.toString("base64")).status,
          1,
        );
      },
    );

    await t.test("the worker key imports into WebCrypto and matches its SPKI", async () => {
      const made = call(openssl, "lab_worker_key", at("w1.key"), at("identity.pk8"), at("w1.spki"));
      assert.equal(made.status, 0, made.stderr);
      const key = await subtle.importKey("pkcs8", readFileSync(at("identity.pk8")), EC, true, [
        "sign",
      ]);
      const jwk = await subtle.exportKey("jwk", key);
      const pub = await subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        EC,
        true,
        ["verify"],
      );
      assert.deepEqual(
        Buffer.from(await subtle.exportKey("spki", pub)),
        readFileSync(at("w1.spki")),
      );
      assert.equal(
        execFileSync("sh", ["-c", 'wc -c < "$1" | tr -d " "', "sh", at("w1.spki")], {
          encoding: "utf8",
        }),
        "91\n",
      );
    });
  });
}
