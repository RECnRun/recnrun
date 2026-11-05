import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALICE, BOB, NAMESPACE, presence } from "./lab.mjs";

export const script = fileURLToPath(new URL("./lifecycle.sh", import.meta.url));
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Logs one line per launch; writes the ack of its token when STUB_ACK is set; stays alive for
// STUB_ALIVE seconds (deaf to SIGTERM with STUB_DEAF) so the pid rules have a process to look at.
// With RECNRUN_STUB_FORWARD it is a forwarder: it acks and exits at once, as a Chrome does when the
// process singleton hands its command line to the browser already running on the root.
const STUB = `#!/bin/sh
for a in "$@"; do last=$a; done
printf 'launch\\n' >>"$STUB_LOG"
token=\${last#*token=}
if [ -n "\${STUB_ACK:-}" ]; then
  sleep "\${STUB_DELAY:-0}"
  dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$STUB_PROFILE
  mkdir -p "$dir"
  printf '%s' '{"token":"'$token'","profileId":"'$STUB_PROFILE'","identity":{"key":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","signedAt":1,"signature":"SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"},"boot":"'$token'","createdAt":1}' >"$dir/$token.json"
fi
[ -n "\${RECNRUN_STUB_FORWARD:-}" ] && exit 0
[ -n "\${STUB_ALIVE:-}" ] || exit 0
if [ -n "\${STUB_DEAF:-}" ]; then trap '' TERM; else trap 'kill $s 2>/dev/null; exit 0' TERM; fi
sleep "$STUB_ALIVE" &
s=$!
wait $s
`;

export const env = (extra) => ({ PATH: process.env.PATH, ...extra });
export function life(shell, args, vars) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: env(vars),
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
export const alive = (pid) => {
  if (spawnSync("kill", ["-0", String(pid)]).status !== 0) return false;
  return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.startsWith("Z");
};
export const lines = (text) => text.split("\n").filter((line) => line !== "");

/** Kills what the scene left running: spawned bystanders and the pid its state file names. */
function killLeftovers(spawned, state) {
  const file = join(state, "profiles", ALICE);
  const named = existsSync(file) ? /^pid=(\d+)$/m.exec(readFileSync(file, "utf8")) : null;
  for (const pid of [...spawned, ...(named ? [Number(named[1])] : [])])
    if (alive(pid)) process.kill(pid, "SIGKILL");
}

/** The stub Chrome, a Chrome root with one profile (two with `shared`), and the record that registers it. */
function install(home, shared) {
  const root = join(home, "Chrome");
  const record = join(home, "launcher.record");
  const chrome = join(home, APP);
  mkdirSync(join(chrome, ".."), { recursive: true });
  writeFileSync(chrome, STUB);
  chmodSync(chrome, 0o755);
  mkdirSync(join(root, "Default"), { recursive: true });
  writeFileSync(join(root, "Default/Preferences"), "{}");
  const block = (id, directory) =>
    `userDataDir=${root}\nprofileDirectory=${directory}\nprofileId=${id}\nnamespace=${NAMESPACE}\n`;
  const second = shared ? `\n${block(BOB, "Profile 1")}` : "";
  if (shared) {
    mkdirSync(join(root, "Profile 1"), { recursive: true });
    writeFileSync(join(root, "Profile 1/Preferences"), "{}");
  }
  writeFileSync(record, block(ALICE, "Default") + second);
  return { root, record };
}

/** The environment of a launcher run: the fixture home, the stub's settings, and the lab's timing. */
function environment(home, defaults, extra) {
  return {
    HOME: home,
    RECNRUN_DISCOVERY_PREFIX: home,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
    RECNRUN_OPEN_TIMEOUT_S: "1",
    RECNRUN_LIFECYCLE_BACKOFF_S: "1",
    STUB_LOG: join(home, "launches.txt"),
    STUB_ROOT: join(home, "Downloads"),
    STUB_NS: NAMESPACE,
    STUB_PROFILE: ALICE,
    STUB_ACK: "1",
    STUB_ALIVE: "30",
    ...defaults,
    ...extra,
  };
}

/** Writes a fresh presence of the profile where the extension would. */
function publishPresence(home) {
  const folder = join(home, "Downloads/RECnRun/poc", NAMESPACE, "peers", ALICE);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "presence.json"), JSON.stringify(presence(ALICE)));
}

/** A temporary home with a stub Chrome, one registered profile (two of one root with `shared`), a state folder, and the environment. */
export function scene(context, defaults = {}, { shared = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-life-"));
  const state = join(home, "state");
  const log = join(home, "launches.txt");
  const spawned = [];
  context.after(() => {
    killLeftovers(spawned, state);
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(state);
  const { root, record } = install(home, shared);
  const vars = (extra) => environment(home, defaults, extra);
  const stateFile = (id = ALICE) => join(state, "profiles", id);
  return {
    home,
    state,
    root,
    record,
    vars,
    stateFile,
    spawned,
    publish: () => publishPresence(home),
    request: (shell, extra, id = ALICE, ...rest) =>
      life(shell, ["request", state, record, NAMESPACE, id, ...rest], vars(extra)),
    launches: () => (existsSync(log) ? lines(readFileSync(log, "utf8")).length : 0),
    field: (key, id = ALICE) =>
      lines(readFileSync(stateFile(id), "utf8"))
        .find((line) => line.startsWith(`${key}=`))
        ?.slice(key.length + 1),
  };
}
