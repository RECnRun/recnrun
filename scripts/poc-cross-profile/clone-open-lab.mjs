import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOB, NAMESPACE, announce, presence } from "./lab.mjs";
import { environment } from "./base-lab.mjs";
import { cloneScene, fields, frozenBase } from "./clone-lab.mjs";

const script = fileURLToPath(new URL("./clone-open.sh", import.meta.url));
export const MASTER = BOB;
export const MARKER_FILE = ".recnrun-clone";
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const masterBlock = (home, role = "master") =>
  [
    `userDataDir=${home}/Master`,
    "profileDirectory=Default",
    `profileId=${MASTER}`,
    `namespace=${NAMESPACE}`,
    `role=${role}`,
    `downloadsRoot=${home}/master-downloads`,
  ].join("\n");

/** A frozen base, a published clone `c1`, a master's presence, and a record that names the master. */
export function openScene(context, shell) {
  const s = cloneScene(context);
  frozenBase(s, shell);
  const created = s.copyTo(shell, "base-v1", "c1");
  if (created.code !== 0) throw new Error(created.err);
  const root = join(s.clones, "c1");
  const record = join(s.home, "launcher.record");
  announce(join(s.home, "master-downloads"), presence(MASTER));
  writeFileSync(record, `${masterBlock(s.home)}\n`);
  const read = (name) => readFileSync(name, "utf8");
  const scene = {
    ...s,
    root,
    record,
    marker: () => read(join(root, MARKER_FILE)),
    instance: () => fields(read(join(root, MARKER_FILE))).instanceId,
    recordText: () => read(record),
    /** Runs `open-clone` on `c1`; `args` replaces the defaults, `extra` the stub's environment. */
    open: (args, extra = {}) => {
      const argv = args ?? [s.clones, "c1", record, NAMESPACE];
      const vars = environment(s.home, "base-v1", {
        STUB_ROOT: join(root, "downloads"),
        RECNRUN_OPEN_TIMEOUT_S: "3",
        ...extra,
      });
      const result = spawnSync(shell, [script, "open-clone", ...argv], {
        encoding: "utf8",
        env: { ...vars, PATH: `${join(s.home, "ps-stub")}:${process.env.PATH}` },
        timeout: 60_000,
      });
      for (const [, pid] of result.stderr.matchAll(/\bpid=(\d+)/g)) s.spawned.push(Number(pid));
      return { code: result.status, out: result.stdout, err: result.stderr };
    },
    /** Starts the stub Chrome on the clone root, as an open clone would be. */
    holdClone: () => {
      const child = spawn(join(s.home, APP), [`--user-data-dir=${root}`], {
        stdio: "ignore",
        env: environment(s.home, "base-v1", { STUB_ALIVE: "30" }),
      });
      s.spawned.push(child.pid);
      spawnSync("sleep", ["0.3"]);
      return child.pid;
    },
    setRecord: (text) => writeFileSync(record, text),
    launches: () => s.launchCount(),
  };
  mkdirSync(join(s.home, "Master"), { recursive: true });
  return scene;
}

/** The presence of the master with its identity replaced (undefined drops the key). */
export const presenceWith = (identity) =>
  JSON.stringify({ ...presence(MASTER), identity: identity === undefined ? undefined : identity });
