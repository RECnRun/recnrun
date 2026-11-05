import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALICE, BOB, CAROL } from "./lab.mjs";
import { alive, env, lines, scene } from "./lifecycle-lab.mjs";

export const launcherScript = fileURLToPath(new URL("./recnrun-launcher.sh", import.meta.url));
const NAMESPACE_OTHER = "other-1";

/** One run of the launcher's entry point; a non-zero exit is a result, not a throw. */
export function launcher(shell, args, vars) {
  const result = spawnSync(shell, [launcherScript, ...args], {
    encoding: "utf8",
    env: env(vars),
    timeout: 120_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const executable = (path, text) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

// Each stub records its argv under the fixture prefix and answers with the exit code from STUB_RC.
const RECORDER = (name) =>
  `#!/bin/sh\nprintf '${name} %s\\n' "$*" >>"$RECNRUN_DISCOVERY_PREFIX/calls.txt"\n`;
const STUBS = {
  launchctl: `${RECORDER("launchctl")}[ "$1" != print ] || exit "\${STUB_PRINT_RC:-0}"\nexit "\${STUB_RC:-0}"\n`,
  systemctl: `${RECORDER("systemctl")}exit "\${STUB_RC:-0}"\n`,
  "systemd-analyze": `${RECORDER("systemd-analyze")}exit "\${STUB_ANALYZE_RC:-0}"\n`,
};

/** A bin folder of the recording stubs, to put first on PATH. */
function stubBin(home) {
  const bin = join(home, "stubs");
  mkdirSync(bin, { recursive: true });
  for (const [name, text] of Object.entries(STUBS)) executable(join(bin, name), text);
  return bin;
}

/** A folder holding every command of the current PATH except the named ones. */
export function pathWithout(home, names) {
  const bin = join(home, "bin-without");
  mkdirSync(bin, { recursive: true });
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (names.includes(name) || existsSync(join(bin, name))) continue;
      symlinkSync(join(dir, name), join(bin, name));
    }
  }
  return bin;
}

const readPid = (file) =>
  existsSync(file) ? Number(/^pid=(\d+)$/m.exec(readFileSync(file, "utf8"))?.[1]) : 0;

const block = (root, id, namespace) =>
  `\nuserDataDir=${root}\nprofileDirectory=Default\nprofileId=${id}\nnamespace=${namespace}\n`;

/** The lifecycle scene plus a recording Chrome and two more registered profiles: BOB here, CAROL elsewhere. */
export function commandScene(context, defaults = {}) {
  let base;
  // Registered before the scene's own cleanup, so the state files still exist when it reads them.
  context.after(() => {
    for (const id of [ALICE, BOB]) {
      const named = readPid(join(base.state, "profiles", id));
      if (named && alive(named)) process.kill(named, "SIGKILL");
    }
  });
  base = scene(context, defaults);
  const chrome = join(base.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  renameSync(chrome, `${chrome}.real`);
  executable(chrome, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$HOME/argv.txt"\nexec "$0.real" "$@"\n`);
  const roots = {};
  for (const [id, namespace] of [
    [BOB, "lab-1"],
    [CAROL, NAMESPACE_OTHER],
  ]) {
    roots[id] = join(base.home, `Chrome-${id.slice(0, 2)}`);
    mkdirSync(join(roots[id], "Default"), { recursive: true });
    writeFileSync(join(roots[id], "Default/Preferences"), "{}");
    appendFileSync(base.record, block(roots[id], id, namespace));
  }
  const argv = () =>
    existsSync(join(base.home, "argv.txt"))
      ? lines(readFileSync(join(base.home, "argv.txt"), "utf8"))
      : [];
  const calls = () =>
    existsSync(join(base.home, "calls.txt"))
      ? lines(readFileSync(join(base.home, "calls.txt"), "utf8"))
      : [];
  return { ...base, roots, argv, calls, stubs: stubBin(base.home) };
}
