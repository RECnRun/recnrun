import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BOB, NAMESPACE, PEER_BOOT, linkAt, presence, shells } from "./lab.mjs";

const script = fileURLToPath(new URL("./discovery.sh", import.meta.url));
const EX_NOT_FOUND = 66;
const PEER_PATH = ["RECnRun", "poc", NAMESPACE, "peers", BOB];

/* No symbolic link is followed at any folder below the Downloads root (PLAN decision 11). */
for (const shell of shells) {
  for (const [depth, part] of PEER_PATH.entries()) {
    await test(`${shell}: a presence below a linked ${part} does not count as holding the token`, (context) => {
      const home = mkdtempSync(join(tmpdir(), "recnrun-discovery-links-"));
      context.after(() => rmSync(home, { recursive: true, force: true }));
      // Outside HOME, so the bounded find cannot report the real tree as a root.
      const real = mkdtempSync(join(tmpdir(), "recnrun-discovery-real-"));
      context.after(() => rmSync(real, { recursive: true, force: true }));
      const folder = join(real, ...PEER_PATH);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "presence.json"),
        JSON.stringify(presence(BOB, { boot: PEER_BOOT })),
      );
      linkAt(join(home, "Downloads"), real, PEER_PATH, depth);
      mkdirSync(join(home, "Chrome/Default"), { recursive: true });
      const result = spawnSync(
        shell,
        [
          script,
          "profile_downloads_root",
          join(home, "Chrome"),
          "Default",
          join(home, "none"),
          NAMESPACE,
          PEER_BOOT,
        ],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: home, RECNRUN_DISCOVERY_UNAME: "Linux" },
        },
      );
      assert.equal(result.status, EX_NOT_FOUND, result.stdout);
      assert.equal(result.stdout, "");
    });
  }
}
