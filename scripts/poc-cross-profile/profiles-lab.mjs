import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./profiles.sh", import.meta.url));

export function profiles(shell, args, env) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
export const lines = (text) => text.split("\n").filter((line) => line !== "");

/** A temporary home that stands in for the machine: HOME and the probe prefix point at it. */
export function lab(context) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-profiles-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const env = (extra = {}) => ({
    HOME: home,
    RECNRUN_DISCOVERY_PREFIX: home,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
    ...extra,
  });
  return { home, env, record: join(home, "launcher.record") };
}

export function profile(root, name, files = { Preferences: "{}" }) {
  mkdirSync(join(root, name), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), text);
}
