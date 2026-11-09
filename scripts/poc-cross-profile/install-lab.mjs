import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION, environment } from "./base-lab.mjs";
import { alive, installPs } from "./lifecycle-lab.mjs";

const script = fileURLToPath(new URL("./install.sh", import.meta.url));
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const TARGET = "0123456789ABCDEF0123456789ABCDEF";
export const SESSION = "FEDCBA9876543210FEDCBA9876543210";
export const OTHER = "a".repeat(32);

// A Chrome on the DevTools pipe: records its argv, copies every NUL-terminated command of fd 3 to
// STUB_MESSAGES, and answers each on fd 4 as STUB_REPLY says (good; other: another id is loaded;
// silent: no answer at all; noentry: no settings entry is written; linger: Browser.close is answered
// but only a signal ends it, logged as int or term; STUB_SELFTEST names a file written on the load, the
// worker's self-test, and STUB_SELFTEST_AUTO a script sourced there to write it). Started without the
// pipe, it sources STUB_WORKER instead, the bare worker Chrome of the lab launcher. On Browser.close it writes the settings entry Chrome
// keeps and exits. A background sh inherits SIGINT ignored and cannot trap it, while Chrome installs its own
// handler: the stub restarts itself once through perl with SIGINT at its default action.
const STUB = `#!/bin/sh
[ -n "\${STUB_SIGNALS:-}" ] || exec /usr/bin/perl -e '$SIG{INT} = "DEFAULT"; $ENV{STUB_SIGNALS} = 1; exec @ARGV or die' /bin/sh "$0" "$@"
for a in "$@"; do [ "$a" != --remote-debugging-pipe ] || piped=1; done
[ -n "\${piped:-}" ] || [ -z "\${STUB_WORKER:-}" ] || . "$STUB_WORKER"
printf '%s\\n' "$@" >"$STUB_ARGV"
printf 'launch\\n' >>"$STUB_LOG"
for a in "$@"; do case $a in --user-data-dir=*) root=\${a#*=} ;; esac; done
mode=\${STUB_REPLY:-good}
: >"$STUB_MESSAGES"
cat <&3 >>"$STUB_MESSAGES" &
reader=$!
trap 'printf "int\\n" >>"$STUB_LOG"; kill $reader 2>/dev/null; exit 0' INT
trap 'printf "term\\n" >>"$STUB_LOG"; kill $reader 2>/dev/null; exit 0' TERM
reply() { printf '%s\\0' "$1" >&4; }
seen=0
while :; do
  count=$(tr -cd '\\000' <"$STUB_MESSAGES" | wc -c | tr -d ' ')
  while [ "$seen" -lt "$count" ]; do
    seen=$((seen + 1))
    message=$(tr '\\000' '\\n' <"$STUB_MESSAGES" | sed -n "\${seen}p")
    id=\${message#'{"id":'}
    id=\${id%%,*}
    [ "$mode" != silent ] || continue
    case $message in
      *'"method":"Extensions.loadUnpacked"'*)
        loaded=$STUB_EXTENSION
        [ "$mode" != other ] || loaded=${OTHER}
        [ -z "\${STUB_SELFTEST:-}" ] || printf '{"generation":1}' >"$STUB_SELFTEST"
        [ -z "\${STUB_SELFTEST_AUTO:-}" ] || . "$STUB_SELFTEST_AUTO"
        reply '{"id":'$id',"result":{"id":"'$loaded'"}}' ;;
      *'"method":"Target.createTarget"'*) reply '{"id":'$id',"result":{"targetId":"${TARGET}"}}' ;;
      *'"method":"Target.attachToTarget"'*) reply '{"id":'$id',"result":{"sessionId":"${SESSION}"}}' ;;
      *'"method":"Runtime.evaluate"'*)
        reply '{"id":'$id',"result":{"result":{"type":"boolean","value":true}},"sessionId":"${SESSION}"}' ;;
      *'"method":"Browser.close"'*)
        [ "$mode" = noentry ] || printf '{"extensions":{"settings":{"%s":{"location":4,"path":"%s"}}}}' \\
          "$STUB_EXTENSION" "$STUB_BUILD" >"$root/Default/Secure Preferences"
        reply '{"id":'$id',"result":{}}'
        [ "$mode" = linger ] || { kill $reader 2>/dev/null; exit 0; } ;;
    esac
  done
  sleep 0.05
done
`;

const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

/** Writes `<bases>/<name>` the way base.sh create-base does, with no Chrome started. */
export function writeBase(bases, name = "base-v1") {
  const root = join(bases, name);
  mkdirSync(join(root, "Default"), { recursive: true });
  const pin = `{"download":{"default_directory":"${root}/downloads","directory_upgrade":true,"prompt_for_download":false}}`;
  writeFileSync(join(root, "Default/Preferences"), pin);
  return root;
}

/** The home's bases folder, a build with a manifest, the ps that shows the stub, and the stub itself. */
function furnish(home) {
  mkdirSync(join(home, "bases"));
  mkdirSync(join(home, "build"));
  writeFileSync(join(home, "build/manifest.json"), "{}");
  installPs(home);
  const chrome = join(home, APP);
  mkdirSync(join(chrome, ".."), { recursive: true });
  writeFileSync(chrome, STUB);
  chmodSync(chrome, 0o755);
}

/** Puts the pipe stub as Chrome in `home` (a lab that already has another stub) and returns a build with a manifest. */
export function pipeChrome(home) {
  const build = join(home, "build");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "manifest.json"), "{}");
  const chrome = join(home, APP);
  writeFileSync(`${chrome}.pipe`, STUB);
  chmodSync(`${chrome}.pipe`, 0o755);
  renameSync(`${chrome}.pipe`, chrome); // a rename replaces a stub that may still be running
  return build;
}

/** A temporary home with the pipe stub as Chrome, a bases folder, a build, and a ps that shows the stub. */
export function installScene(context) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-install-"));
  const spawned = [];
  context.after(() => {
    for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  furnish(home);
  const bases = join(home, "bases");
  const build = join(home, "build");
  const messages = join(home, "messages");
  const run = (shell, args, extra = {}) => {
    const result = spawnSync(shell, [script, ...args], {
      encoding: "utf8",
      env: environment(home, "base-v1", {
        STUB_MESSAGES: messages,
        STUB_EXTENSION: EXTENSION,
        STUB_BUILD: build,
        TMPDIR: home,
        ...extra,
      }),
      timeout: 60_000,
    });
    for (const [, pid] of result.stderr.matchAll(/\bpid=(\d+)/g)) spawned.push(Number(pid));
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return {
    home,
    bases,
    build,
    run,
    spawned,
    install: (shell, extra = {}, name = "base-v1", namespace = "lab-1") =>
      run(shell, ["install-base", bases, name, namespace, build], extra),
    argv: () => readLines(join(home, "argv.txt")),
    launches: () => readLines(join(home, "launches.txt")),
    /** The commands the stub read, parsed. */
    messages: () =>
      existsSync(messages)
        ? readFileSync(messages, "utf8")
            .split("\0")
            .filter(Boolean)
            .map((text) => JSON.parse(text))
        : [],
  };
}
