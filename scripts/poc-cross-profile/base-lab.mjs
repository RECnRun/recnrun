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
import { ALICE, NAMESPACE } from "./lab.mjs";
import { alive, env, installPs } from "./lifecycle-lab.mjs";

const script = fileURLToPath(new URL("./base.sh", import.meta.url));
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const EXTENSION = readFileSync(new URL("./extension-id", import.meta.url), "utf8").trim();
export const MARKER = ".recnrun-base";

const IDENT = `"identity":{"key":"${"B".repeat(87)}","signedAt":1,"signature":"${"S".repeat(86)}"}`;

// Records its argv; on a template URL writes the ack STUB_ACK names (good: the template ack, which
// carries no identity; plain: a token ack without the template fields); on a clone URL, when STUB_CLONE
// is set, writes the clone ack (unprovisioned drops the provisioned field, symlink and oversize change the file; STUB_BODY_*
// change one value of the body); on a token URL, when STUB_REOPEN is set, writes the token ack of open.sh; stays
// alive STUB_ALIVE seconds (deaf to SIGTERM with STUB_DEAF).
const STUB = `#!/bin/sh
printf '%s\\n' "$@" >"$STUB_ARGV"
printf 'launch\\n' >>"$STUB_LOG"
for a in "$@"; do last=$a; done
case $last in
  *'#template='*)
    rest=\${last#*#template=}
    token=\${rest%%&*}
    setting=\${rest#*&setting=}
    if [ -n "\${STUB_ACK:-}" ]; then
      dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$STUB_PROFILE
      mkdir -p "$dir"
      tail=
      ident=',${IDENT}'
      [ "$STUB_ACK" != good ] || { tail=',"template":true,"setting":"'\${STUB_SETTING:-$setting}'"'; ident=; }
      printf '%s' '{"token":"'$token'","profileId":"'$STUB_PROFILE'"'"$ident"',"boot":"'$token'","createdAt":1'"$tail"'}' >"$dir/$token.json"
    fi
    ;;
  *'#clone='*)
    rest=\${last#*#clone=}
    token=\${rest%%&*}
    rest=\${rest#*&instance=}
    instance=\${rest%%&*}
    rest=\${rest#*&operation=}
    operation=\${rest%%&*}
    if [ -n "\${STUB_CLONE:-}" ]; then
      dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$instance
      mkdir -p "$dir"
      prov=',"provisioned":true'
      [ "$STUB_CLONE" != unprovisioned ] || prov=
      id=\${STUB_BODY_INSTANCE:-$instance}
      body='{"token":"'\${STUB_BODY_TOKEN:-$token}'","profileId":"'$id'",${IDENT},"boot":"'$token'","instanceId":"'$id'","operationId":"'\${STUB_BODY_OPERATION:-$operation}'"'"$prov"',"createdAt":1}'
      case $STUB_CLONE in
        symlink) printf '%s' "$body" >"$STUB_ROOT/real.json"; ln -s "$STUB_ROOT/real.json" "$dir/$token.json" ;;
        oversize) { printf '%s' "$body"; head -c 5000 /dev/zero | tr '\\0' ' '; } >"$dir/$token.json" ;;
        *) printf '%s' "$body" >"$dir/$token.json" ;;
      esac
    fi
    ;;
  *'#token='*)
    token=\${last#*#token=}
    if [ -n "\${STUB_REOPEN:-}" ]; then
      dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$STUB_PROFILE
      mkdir -p "$dir"
      printf '%s' '{"token":"'$token'","profileId":"'$STUB_PROFILE'",${IDENT},"boot":"'$token'","createdAt":1}' >"$dir/$token.json"
    fi
    ;;
esac
[ -n "\${STUB_ALIVE:-}" ] || exit 0
if [ -n "\${STUB_DEAF:-}" ]; then trap '' TERM; else trap 'kill $s 2>/dev/null; exit 0' TERM; fi
sleep "$STUB_ALIVE" &
s=$!
wait $s
`;

/** The temporary home: bases folder, the ps that shows the stub as Chrome, and the stub itself. */
function makeHome(context, spawned) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-base-"));
  context.after(() => {
    for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(join(home, "bases"));
  installPs(home);
  const chrome = join(home, APP);
  mkdirSync(join(chrome, ".."), { recursive: true });
  writeFileSync(chrome, STUB);
  chmodSync(chrome, 0o755);
  return home;
}

/** The environment of one run: the fixture home, the stub's settings, and the lab's timing. */
export function environment(home, name, extra) {
  return env({
    HOME: home,
    PATH: `${join(home, "ps-stub")}:${process.env.PATH}`,
    RECNRUN_DISCOVERY_PREFIX: home,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
    RECNRUN_OPEN_TIMEOUT_S: "2",
    RECNRUN_LIFECYCLE_STOP_S: "2",
    STUB_ARGV: join(home, "argv.txt"),
    STUB_LOG: join(home, "launches.txt"),
    STUB_ROOT: join(home, "bases", name, "downloads"),
    STUB_NS: NAMESPACE,
    STUB_PROFILE: ALICE,
    ...extra,
  });
}

/** Waits (briefly, synchronously) until `path` holds a line: a background stub writes it late. */
function settled(path) {
  for (let tries = 0; tries < 100 && readLines(path).length === 0; tries += 1) {
    spawnSync("sleep", ["0.05"]);
  }
  return readLines(path);
}

const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

/** A temporary home with a stub Chrome, a bases folder, and a ps that shows the stub as Chrome. */
export function baseScene(context) {
  const spawned = [];
  const home = makeHome(context, spawned);
  const bases = join(home, "bases");
  const run = (shell, args, name = "base-v1", extra = {}) => {
    const result = spawnSync(shell, [script, ...args], {
      encoding: "utf8",
      env: environment(home, name, extra),
      timeout: 60_000,
    });
    for (const [, pid] of result.stderr.matchAll(/\bpid=(\d+)/g)) spawned.push(Number(pid));
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return {
    home,
    bases,
    run,
    spawned,
    root: (name = "base-v1") => join(bases, name),
    argv: () => settled(join(home, "argv.txt")),
    launchCount: () => readLines(join(home, "launches.txt")).length,
    create: (shell, name = "base-v1", extra = {}) => {
      const result = run(shell, ["create-base", bases, name], name, extra);
      if (result.code === 0) settled(join(home, "launches.txt"));
      return result;
    },
  };
}

/** Puts the extension into the base's Preferences the way an unpacked install does, keeping the pin. */
export function installExtension(root) {
  writeFileSync(
    join(root, "Default/Preferences"),
    `{"download":{"default_directory":"${root}/downloads","prompt_for_download":false},` +
      `"extensions":{"settings":{"${EXTENSION}":{"path":"/x"}}}}`,
  );
}
