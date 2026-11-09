import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EXTENSION, environment } from "../../../../scripts/poc-cross-profile/base-lab.mjs";
import { installScene } from "../../../../scripts/poc-cross-profile/install-lab.mjs";
import { alive } from "../../../../scripts/poc-cross-profile/lifecycle-lab.mjs";

export const launcher = fileURLToPath(new URL("./launcher.sh", import.meta.url));
export const EX_USAGE = 64;
export const EX_FAILED = 70;
export const EX_LOCKED = 75;

export async function waitFor(condition, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out after ${ms} ms`);
}

/** A P-256 master key as the site makes it: the pair, its 91-byte SPKI, and the 64-hex fingerprint. */
export async function masterKey() {
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  const fp = Buffer.from(await subtle.digest("SHA-256", spki)).toString("hex");
  return { pair, spki, fp };
}

// WebCrypto signs P1363 (r||s); openssl verifies DER, as the site's request signer sends it.
function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.subarray(start);
  const pad = body[0] & 0x80 ? [0] : [];
  return [0x02, body.length + pad.length, ...pad, ...body];
}
export function p1363ToDer(signature) {
  const raw = new Uint8Array(signature);
  const seq = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return Buffer.from([0x30, seq.length, ...seq]);
}

/** The nine body lines of a request (v2 B5), each with its newline. */
export function requestBody(f) {
  const lines = [
    "recnrun-lab-request v1",
    `workspace=${f.workspace}`,
    `session=${f.session}`,
    `request=${f.rid}`,
    "action=start",
    `root=${f.root ?? "w1"}`,
    `offer=${f.offer}`,
    `attempt=${f.attempt}`,
    `expires=${f.expires ?? Math.floor(Date.now() / 1000) + 60}`,
  ];
  return lines.map((line) => `${line}\n`).join("");
}

/** A request signed by the master's private key: the body plus `sig=<base64 DER>`. */
export async function signedRequest(privateKey, body) {
  const algorithm = { name: "ECDSA", hash: "SHA-256" };
  const p1363 = await globalThis.crypto.subtle.sign(algorithm, privateKey, Buffer.from(body));
  return `${body}sig=${p1363ToDer(p1363).toString("base64")}\n`;
}

export const ALLOW = ["--allow", "http://127.0.0.1:4600"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A started launcher in a workspace the site has marked; paired with `key` when one is given. */
export async function markedLauncher(
  s,
  { args = ALLOW, extra = {}, key, workspace = randomUUID() } = {},
) {
  const run = s.start(key ? [...args, "--pair", key.fp] : args, extra);
  await waitFor(() => s.heartbeat().seq !== undefined);
  writeFileSync(join(s.ws, "recnrun-workspace.json"), `{\n  "workspaceId": "${workspace}"\n}\n`);
  if (key) {
    writeFileSync(join(s.ws, "pairing/master.spki"), key.spki);
    await waitFor(() => s.heartbeat().paired === key.fp);
  }
  return { run, key: key ?? (await masterKey()), workspace, session: s.heartbeat().session };
}
export const pairedLauncher = async (s, options = {}) =>
  markedLauncher(s, { key: await masterKey(), ...options });

/** Writes an offer and its signed request as the site does; `f` overrides fields or the text. */
export async function submit(s, p, f = {}) {
  const rid = f.rid ?? randomUUID();
  const attempt = f.attempt ?? randomUUID();
  const offerBytes = Buffer.from(f.offerBytes ?? `{"type":"offer","attempt":"${attempt}"}\n`);
  writeFileSync(join(s.ws, `exchange/w1/offer-${attempt}.json`), offerBytes);
  const fieldsIn = { workspace: p.workspace, session: p.session, offer: sha256(offerBytes) };
  const body = requestBody({ ...fieldsIn, ...f, rid, attempt });
  const signed = await signedRequest((f.signer ?? p.key.pair).privateKey, body);
  const text = f.mutate ? f.mutate(signed) : signed;
  writeFileSync(join(s.ws, `requests/${rid}.req`), text);
  return { rid, attempt, text, offerBytes };
}
export const statusOf = (s, rid) => fields(join(s.ws, `status/${rid}.status`));

/** The key=value lines of a file as an object; {} when it is missing. */
export function fields(path) {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  return Object.fromEntries(entries);
}

/** One launcher run; detached, so it has no controlling terminal and /dev/tty cannot open. */
function startRun(shell, args, env, spawned) {
  const child = spawn(shell, [launcher, ...args], { detached: true, env });
  spawned.push(child.pid);
  const run = { pid: child.pid, out: "", err: "", code: undefined };
  child.stdout.on("data", (chunk) => (run.out += chunk));
  child.stderr.on("data", (chunk) => (run.err += chunk));
  run.exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      run.code = code ?? signal;
      resolve(run.code);
    }),
  );
  return run;
}

// The bare worker Chrome, sourced by the fake Chrome: STUB_WORKER_MODE renamed execs into another
// program, stubborn ignores SIGINT; otherwise SIGINT ends it, as Chrome's shutdown does. It answers
// the offer current.json names as STUB_WORKER_ANSWER says: answer (through a .crdownload, renamed),
// crdownload (partial bytes beside a .crdownload for a second), oversize, never, late (only once
// relaunched), or linked (no answer; state.json says linked).
const WORKER = `printf '%s\\n' "$@" >"$STUB_WORKER_ARGV"
printf 'worker\\n' >>"$STUB_LOG"
for a in "$@"; do case $a in --user-data-dir=*) w=\${a#*=} ;; esac; done
w=\${w%/chrome}
case \${STUB_WORKER_MODE:-} in
  renamed) exec /bin/sleep 600 ;;
  stubborn) trap '' INT ;;
  *) trap 'printf "worker int\\n" >>"$STUB_LOG"; exit 0' INT ;;
esac
answer() {
  a=$(sed -n 's/.*"attempt":"\\([0-9a-f-]*\\)".*/\\1/p' "$w/ext/exchange/current.json" 2>/dev/null)
  [ -n "$a" ] && [ "$a" != "\${seen:-}" ] || return 0
  seen=$a
  f=$w/downloads/answer-$a.json
  body='{"type":"answer","attempt":"'$a'"}'
  case \${STUB_WORKER_ANSWER:-answer} in
    never) ;;
    late) [ "$(grep -c '^worker$' "$STUB_LOG")" -lt 2 ] || printf '%s' "$body" >"$f" ;;
    oversize) head -c 70000 /dev/zero | tr '\\000' x >"$f" ;;
    linked) printf '{"state":"linked","attempt":"%s","at":%s000}' "$a" "$(date +%s)" >"$w/downloads/state.json" ;;
    crdownload)
      : >"$f.crdownload"
      printf partial >"$f"
      sleep 1
      printf '%s' "$body" >"$f"
      rm -f "$f.crdownload" ;;
    *) printf '%s' "$body" >"$f.crdownload" && mv "$f.crdownload" "$f" ;;
  esac
}
while :; do answer; sleep 0.1 & wait $!; done
`;

// The worker's self-test as the extension downloads it, from the policy and identity it was given.
const SELFTEST = `st_root=\${root%/chrome}
st_gen=$(sed -n 's/.*"generation":\\([0-9]*\\).*/\\1/p' "$st_root/ext/policy.json")
st_version=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$st_root/ext/manifest.json" | head -n 1)
st_digest=$(openssl dgst -sha256 -binary <"$st_root/ext/policy.json" | od -An -v -tx1 | tr -d ' \\n')
st_spki=$(openssl pkey -inform DER -in "$st_root/ext/identity.pk8" -pubout -outform DER | openssl base64 -A)
printf '{"generation":%s,"extensionVersion":"%s","policyDigest":"%s","workerSpki":"%s","fileRead":false}' \\
  "$st_gen" "$st_version" "$st_digest" "$st_spki" >"$st_root/downloads/provisioned-$st_gen.json"
`;

/** A temporary home with the fake Chrome, its ps, and a lab folder for the launcher. */
export function launcherScene(context, shell) {
  const s = installScene(context);
  const lab = join(s.home, "lab");
  writeFileSync(join(s.home, "worker.sh"), WORKER);
  writeFileSync(join(s.home, "selftest.sh"), SELFTEST);
  const env = (extra) =>
    environment(s.home, "base-v1", {
      STUB_MESSAGES: join(s.home, "messages"),
      STUB_EXTENSION: EXTENSION,
      STUB_BUILD: join(lab, "roots/w1/ext"),
      STUB_WORKER: join(s.home, "worker.sh"),
      STUB_WORKER_ARGV: join(s.home, "worker-argv.txt"),
      STUB_SELFTEST_AUTO: join(s.home, "selftest.sh"),
      TMPDIR: s.home,
      RECNRUN_LAB_TICK_S: "0.2",
      RECNRUN_LAB_HEARTBEAT_S: "0.2",
      RECNRUN_LAB_STOP_S: "2",
      RECNRUN_LAB_INSTALL_S: "3",
      RECNRUN_LAB_ANSWER_S: "2",
      ...extra,
    });
  context.after(() => {
    for (const pid of s.spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return {
    ...s,
    lab,
    ws: join(lab, "workspace"),
    state: join(lab, "state"),
    root: join(lab, "roots/w1"),
    start: (args = ["--allow", "http://127.0.0.1:4600"], extra = {}) =>
      startRun(shell, ["start", lab, ...args], env(extra), s.spawned),
    heartbeat: () => fields(join(lab, "workspace/launcher/heartbeat")),
  };
}
