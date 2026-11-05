import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALICE, presence } from "./lab.mjs";
import { env, scene } from "./lifecycle-lab.mjs";

const firstRunScript = fileURLToPath(new URL("./first-run.sh", import.meta.url));
const EXTENSION = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const DEFAULT_ROOT = "Library/Application Support/Google/Chrome";

/**
 * The lifecycle scene turned into a machine that never ran the launcher: the stub Chrome and its
 * profile sit at the OS default root with the extension in Preferences, a presence is out in
 * ~/Downloads under `namespace`, and no record exists.
 */
export function firstRunScene(context, namespace = "lab") {
  const base = scene(context, { STUB_NS: namespace });
  const root = join(base.home, DEFAULT_ROOT);
  mkdirSync(join(base.home, "Library/Application Support/Google"), { recursive: true });
  renameSync(base.root, root);
  writeFileSync(
    join(root, "Default/Preferences"),
    `{"extensions":{"settings":{"${EXTENSION}":{"path":"/x"}}}}`,
  );
  rmSync(base.record);
  const folder = join(base.home, "Downloads/RECnRun/poc", namespace, "peers", ALICE);
  const publish = () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "presence.json"), JSON.stringify(presence(ALICE)));
  };
  publish();
  return { ...base, root, folder, unpublish: () => rmSync(folder, { recursive: true }) };
}

/** One run of first-run.sh (or of the file `script`); a non-zero exit is a result, not a throw. */
export function firstRun(shell, args, vars, { script = firstRunScript, cwd } = {}) {
  const result = spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: env(vars),
    timeout: 120_000,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
