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
import { ALICE, BOB, IDENTITY, NAMESPACE, presence } from "./lab.mjs";

export const script = fileURLToPath(new URL("./lifecycle.sh", import.meta.url));
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Logs one line per launch; writes the ack of its token when STUB_ACK is set; stays alive for
// STUB_ALIVE seconds, logging SIGINT or SIGTERM to $HOME/signals.txt (deaf to both with STUB_DEAF), so the
// pid rules have a process to look at. A background sh inherits SIGINT ignored and cannot trap it, while
// Chrome installs its own handler: the stub restarts itself once through perl with SIGINT at its default.
// With RECNRUN_STUB_FORWARD it is a forwarder: it acks and exits at once, as a Chrome does when the
// process singleton hands its command line to the browser already running on the root.
const STUB = `#!/bin/sh
[ -n "\${STUB_SIGNALS:-}" ] || exec /usr/bin/perl -e '$SIG{INT} = "DEFAULT"; $ENV{STUB_SIGNALS} = 1; exec @ARGV or die' /bin/sh "$0" "$@"
for a in "$@"; do last=$a; case $a in --profile-directory=*) directory=\${a#*=} ;; esac; done
printf 'launch\\n' >>"$STUB_LOG"
token=\${last#*token=}
# STUB_IDS_FILE maps "<profile directory>=<profileId>" lines: a directory it does not list never acks.
if [ -n "\${STUB_IDS_FILE:-}" ]; then
  STUB_PROFILE=
  while IFS= read -r entry; do case $entry in "$directory="*) STUB_PROFILE=\${entry#*=} ;; esac; done <"$STUB_IDS_FILE"
  [ -n "$STUB_PROFILE" ] || STUB_ACK=
fi
if [ -n "\${STUB_ACK:-}" ]; then
  sleep "\${STUB_DELAY:-0}"
  dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$STUB_PROFILE
  mkdir -p "$dir"
  printf '%s' '{"token":"'$token'","profileId":"'$STUB_PROFILE'","identity":{"key":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","signedAt":1,"signature":"SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"},"boot":"'$token'","createdAt":1}' >"$dir/$token.json"
fi
[ -n "\${RECNRUN_STUB_FORWARD:-}" ] && exit 0
[ -n "\${STUB_ALIVE:-}" ] || exit 0
if [ -n "\${STUB_DEAF:-}" ]; then
  trap '' INT TERM
else
  trap 'printf "int\\n" >>"$HOME/signals.txt"; kill $s 2>/dev/null; exit 0' INT
  trap 'printf "term\\n" >>"$HOME/signals.txt"; kill $s 2>/dev/null; exit 0' TERM
fi
sleep "$STUB_ALIVE" &
s=$!
wait $s
`;

// The real ps with a shebang script shown as the program it stands for (as an exec'd Chrome would be),
// so the guards that read a command line meet what a real Chrome shows. STUB_PS_CMD answers the
// command line of STUB_PS_PID (any pid when unset); from the second command line asked on,
// STUB_PS_CMD_AFTER answers instead, which stands for a pid recycled between two guards.
const PS = (ps) => `#!/bin/sh
if [ "$1" = -o ] && [ "$2" = command= ] && [ "$3" = -p ] && { [ -z "\${STUB_PS_PID:-}" ] || [ "$4" = "$STUB_PS_PID" ]; }; then
  n=$(cat "$HOME/ps-count" 2>/dev/null || echo 0)
  printf '%s\\n' "$((n + 1))" >"$HOME/ps-count"
  [ "$n" -eq 0 ] || [ -z "\${STUB_PS_CMD_AFTER:-}" ] || { printf '%s\\n' "$STUB_PS_CMD_AFTER"; exit 0; }
  [ -z "\${STUB_PS_CMD:-}" ] || { printf '%s\\n' "$STUB_PS_CMD"; exit 0; }
fi
${ps} "$@" | sed -E -e 's,(^|[[:space:]])(/bin/|/usr/bin/)?(da)?sh /,\\1/,' -e 's,Google Chrome\\.real,Google Chrome,'
`;

export function installPs(home) {
  const real = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(join(home, "ps-stub"));
  writeFileSync(join(home, "ps-stub/ps"), PS(real));
  chmodSync(join(home, "ps-stub/ps"), 0o755);
}

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
  for (const pid of [...spawned, ...(named ? [Number(named[1])] : [])]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // A process that is already gone is the goal; a scene's own cleanup may have just killed it.
      if (error.code !== "ESRCH") throw error;
    }
  }
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
    PATH: `${join(home, "ps-stub")}:${process.env.PATH}`,
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

/** Writes the paused.json of the profile where the extension would; `text` replaces its exact bytes. */
function publishPause(home, reason, text) {
  const folder = join(home, "Downloads/RECnRun/poc", NAMESPACE, "peers", ALICE);
  mkdirSync(folder, { recursive: true });
  const bytes = JSON.stringify({
    profileId: ALICE,
    reason,
    identity: IDENTITY,
    createdAt: Date.now(),
  });
  const file = join(folder, "paused.json");
  writeFileSync(file, text ?? bytes);
  return file;
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
  installPs(home);
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
    mark: (reason, text) => publishPause(home, reason, text),
    request: (shell, extra, id = ALICE, ...rest) =>
      life(shell, ["request", state, record, NAMESPACE, id, ...rest], vars(extra)),
    launches: () => (existsSync(log) ? lines(readFileSync(log, "utf8")).length : 0),
    /** The signals the stub Chrome caught, int or term, one line each. */
    signals: () => {
      const file = join(home, "signals.txt");
      return existsSync(file) ? lines(readFileSync(file, "utf8")) : [];
    },
    field: (key, id = ALICE) =>
      lines(readFileSync(stateFile(id), "utf8"))
        .find((line) => line.startsWith(`${key}=`))
        ?.slice(key.length + 1),
  };
}
