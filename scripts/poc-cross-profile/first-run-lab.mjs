import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALICE, BOB, presence } from "./lab.mjs";
import { env, scene } from "./lifecycle-lab.mjs";

const firstRunScript = fileURLToPath(new URL("./first-run.sh", import.meta.url));
const EXTENSION = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const DEFAULT_ROOT = "Library/Application Support/Google/Chrome";

const withExtension = (directory) =>
  `{"extensions":{"settings":{"${EXTENSION}":{"path":"/x"}}},"download":{"default_directory":"${directory}"}}`;

/** The file the stub Chrome reads to answer each profile directory with an id; `ids` null writes none. */
function stubIds(home, ids) {
  const idsFile = join(home, "stub-ids.txt");
  const ack = (map) =>
    writeFileSync(
      idsFile,
      Object.entries(map)
        .map(([directory, id]) => `${directory}=${id}\n`)
        .join(""),
    );
  if (ids) ack(ids);
  return { idsFile, ack };
}

/**
 * The lifecycle scene turned into a machine that never ran the launcher: the stub Chrome and its
 * profile sit at the OS default root with the extension in Preferences, a presence is out in
 * ~/Downloads under `namespace`, and no record exists. With `shared` a second profile, "Profile 1",
 * has the extension too and downloads to the same folder, so neither profile has a Downloads root
 * of its own; the stub acks each directory with the id of `ids` ({ directory: profileId }).
 */
export function firstRunScene(context, namespace = "lab", { shared = false } = {}) {
  const base = scene(context, { STUB_NS: namespace }, { shared });
  const root = join(base.home, DEFAULT_ROOT);
  mkdirSync(join(base.home, "Library/Application Support/Google"), { recursive: true });
  renameSync(base.root, root);
  const downloads = join(base.home, "Downloads");
  writeFileSync(join(root, "Default/Preferences"), withExtension(downloads));
  if (shared) writeFileSync(join(root, "Profile 1/Preferences"), withExtension(downloads));
  rmSync(base.record);
  const folderOf = (id) => join(downloads, "RECnRun/poc", namespace, "peers", id);
  const publish = (id = ALICE) => {
    mkdirSync(folderOf(id), { recursive: true });
    writeFileSync(join(folderOf(id), "presence.json"), JSON.stringify(presence(id, { namespace })));
  };
  publish();
  if (shared) publish(BOB);
  const { idsFile, ack } = stubIds(base.home, shared ? { Default: ALICE, "Profile 1": BOB } : null);
  const vars = (extra) => base.vars(shared ? { STUB_IDS_FILE: idsFile, ...extra } : extra);
  return {
    ...base,
    root,
    vars,
    ack,
    publish,
    folder: folderOf(ALICE),
    unpublish: (id = ALICE) => rmSync(folderOf(id), { recursive: true }),
  };
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
