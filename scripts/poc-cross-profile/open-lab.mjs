import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALICE, NAMESPACE } from "./lab.mjs";

const script = fileURLToPath(new URL("./open.sh", import.meta.url));
export const EX_REFUSED = 65;
export const EX_NO_ACK = 69;
export const EX_BOOTSTRAP_FAILED = 71;
export const BOB = "22222222-2222-4222-8222-222222222222";
export const OTHER_TOKEN = "99999999-9999-4999-8999-999999999999";
export const EXTENSION = readFileSync(new URL("./extension-id", import.meta.url), "utf8").trim();
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Records its argv and, when STUB_ROOT is set, writes an ack for the token in its URL after a delay.
const STUB = `#!/bin/sh
KEY=${"B".repeat(87)}
SIG=${"S".repeat(86)}
for a in "$@"; do last=$a; done
[ -z "\${STUB_HOLD:-}" ] || { sleep "$STUB_HOLD"; exit 0; }
printf '%s\\n' "$@" >"$STUB_ARGV"
[ -n "\${STUB_ROOT:-}" ] || exit 0
sleep "\${STUB_DELAY:-1}"
token=\${STUB_TOKEN:-\${last#*token=}}
boot=\${STUB_BOOT:-$token}
ident='{"key":"'$KEY'","signedAt":1,"signature":"'$SIG'"}'
head='{"token":"'\${STUB_BODY_TOKEN:-$token}'","profileId":"'\${STUB_BODY_PROFILE:-$STUB_PROFILE}'","identity":'
case \${STUB_SHAPE:-good} in
  good) body=$head$ident',"boot":"'$boot'","createdAt":1}' ;;
  trailing) body=$head$ident',"boot":"'$boot'","createdAt":1}x' ;;
  nocreated) body=$head$ident',"boot":"'$boot'"}' ;;
  nested) body=$head'{"key":"'$KEY'","signedAt":1,"signature":"'$SIG'","boot":"'$boot'"},"createdAt":1}' ;;
  noident) body='{"token":"'$token'","profileId":"'$STUB_PROFILE'","boot":"'$boot'","createdAt":1}' ;;
  freeident) body=$head'{"key":"K","signedAt":1,"signature":"S"},"boot":"'$boot'","createdAt":1}' ;;
  failure) body='{"token":"'$token'","profileId":"'$STUB_PROFILE'","failedStep":"'\${STUB_STEP:-publish}'","error":"'\${STUB_ERROR-The offscreen document did not answer.}'","createdAt":1}' ;;
esac
dir=$STUB_ROOT/RECnRun/poc/$STUB_NS/acks/$STUB_PROFILE
mkdir -p "$dir"
case \${STUB_KIND:-good} in
  good) printf '%s' "$body" >"$dir/$token.json" ;;
  symlink) printf '%s' "$body" >"$STUB_ROOT/real.json"; ln -s "$STUB_ROOT/real.json" "$dir/$token.json" ;;
  oversize) { printf '%s' "$body"; head -c 5000 /dev/zero | tr '\\0' ' '; } >"$dir/$token.json" ;;
esac
`;

export function open(shell, args, env) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
export const lines = (text) => text.split("\n").filter((line) => line !== "");

/** A temporary home with a stub Chrome, one registered profile, and the environment to run in. */
export function scene(context, { blocks } = {}) {
  const home = mkdtempSync(join(tmpdir(), "recnrun-open-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Chrome");
  const argv = join(home, "argv.txt");
  const chrome = join(home, APP);
  mkdirSync(join(chrome, ".."), { recursive: true });
  writeFileSync(chrome, STUB);
  chmodSync(chrome, 0o755);
  mkdirSync(join(root, "Default"), { recursive: true });
  writeFileSync(join(root, "Default/Preferences"), "{}");
  const record = join(home, "launcher.record");
  const block = (id, extra = []) =>
    [
      `userDataDir=${root}`,
      "profileDirectory=Default",
      `profileId=${id}`,
      `namespace=${NAMESPACE}`,
      ...extra,
    ].join("\n");
  writeFileSync(record, `${blocks ?? block(ALICE)}\n`);
  const env = (extra = {}) => ({
    HOME: home,
    RECNRUN_DISCOVERY_PREFIX: home,
    RECNRUN_DISCOVERY_UNAME: "Darwin",
    RECNRUN_OPEN_TIMEOUT_S: "2",
    STUB_ARGV: argv,
    STUB_ROOT: join(home, "Downloads"),
    STUB_NS: NAMESPACE,
    STUB_PROFILE: ALICE,
    STUB_DELAY: "0",
    ...extra,
  });
  return { home, root, record, argv, env, block, chrome };
}

/** A main Chrome process on the scene's root (the stub, held for a while) with the given flags. */
export function holdChrome(context, { home, root, chrome }, ...flags) {
  const child = spawn(chrome, [`--user-data-dir=${root}`, ...flags], {
    env: { PATH: process.env.PATH, STUB_HOLD: "30", STUB_ARGV: join(home, "held.txt") },
    stdio: "ignore",
  });
  context.after(() => child.kill());
}
export const request = (record, id = ALICE, ...rest) => ["open", record, NAMESPACE, id, ...rest];
