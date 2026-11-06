import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAROL, IDENTITY, NAMESPACE, announce, presence } from "./lab.mjs";
import { EXTENSION } from "./base-lab.mjs";
import { MASTER, masterBlock } from "./clone-open-lab.mjs";
import { scene } from "./lifecycle-lab.mjs";

const script = fileURLToPath(new URL("./clone-control.sh", import.meta.url));
export const CLONE = CAROL;
export const OTHER = "66666666-6666-4666-8666-666666666666";
export const REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The request the extension writes (CloneControlRequestSchema), in JSON.stringify's key order. */
export const requestText = (overrides = {}) =>
  JSON.stringify({
    requestId: REQUEST,
    kind: "clone-control",
    action: "close",
    instanceId: CLONE,
    namespace: NAMESPACE,
    masterProfileId: MASTER,
    masterIdentity: IDENTITY,
    createdAt: Date.now(),
    ...overrides,
  });

const markerText = (name, id) =>
  [
    "base=base-v1",
    `clone=${name}`,
    `instanceId=${id}`,
    `namespace=${NAMESPACE}`,
    `extensionId=${EXTENSION}`,
    "role=worker",
    "createdAt=1",
    "copyS=1",
    "physicalKiB=1",
    "logicalBytes=1",
    "",
  ].join("\n");

/** Makes a clone root with a profile and its marker; `parent` is the folder that holds it. */
function makeClone(parent, name, id) {
  const root = join(parent, name);
  mkdirSync(join(root, "Default"), { recursive: true });
  writeFileSync(join(root, "Default/Preferences"), "{}");
  writeFileSync(join(root, ".recnrun-clone"), markerText(name, id));
  return root;
}

const workerBlock = (root, id, downloads) =>
  [
    `userDataDir=${root}`,
    "profileDirectory=Default",
    `profileId=${id}`,
    `namespace=${NAMESPACE}`,
    "role=worker",
    `downloadsRoot=${downloads}`,
  ].join("\n");

/** The block of a master that is a real extension profile: its id and the Downloads root it writes to. */
const realMasterBlock = (home, real) =>
  [
    `userDataDir=${home}/Master`,
    "profileDirectory=Default",
    `profileId=${real.id}`,
    `namespace=${NAMESPACE}`,
    "role=master",
    `downloadsRoot=${real.downloads}`,
  ].join("\n");

/** Lays out the master's folders, a clone `w1` under clones/, a stray one outside it, and the record. */
function layout(s, real) {
  const downloads = join(s.home, "Downloads");
  const master = real?.downloads ?? join(s.home, "master-downloads");
  const control = join(master, "RECnRun/poc", NAMESPACE, "control");
  const root = makeClone(join(s.home, "bases/clones"), "w1", CLONE);
  const stray = makeClone(join(s.home, "bases/other"), "w2", OTHER);
  mkdirSync(join(s.home, "Master"), { recursive: true });
  mkdirSync(join(downloads, "RECnRun/poc", NAMESPACE), { recursive: true });
  if (!real) announce(master, presence(MASTER));
  mkdirSync(control, { recursive: true });
  const blocks = [
    real ? realMasterBlock(s.home, real) : masterBlock(s.home),
    workerBlock(root, CLONE, downloads),
    workerBlock(stray, OTHER, downloads),
  ];
  writeFileSync(s.record, `${blocks.join("\n\n")}\n`);
  return { root, stray, master, control };
}

/** Reads and writes the control folder of a scene. */
function accessors(control) {
  const folder = (id = REQUEST) => join(control, id);
  const json = (file) => {
    const raw = readFileSync(file, "utf8");
    return { raw, ...JSON.parse(raw) };
  };
  return {
    folder,
    /** Writes the request folder of `id`; `overrides` replace keys of the closed layout. */
    write: (overrides = {}, id = REQUEST) => {
      mkdirSync(folder(id), { recursive: true });
      writeFileSync(join(folder(id), "request.json"), requestText({ requestId: id, ...overrides }));
    },
    status: (id = REQUEST) => json(join(folder(id), "status.json")),
    hasStatus: (id = REQUEST) => existsSync(join(folder(id), "status.json")),
    clones: () => json(join(control, "clones.json")),
  };
}

/** The lifecycle scene with a master, a worker clone `w1` under clones/, and a second one outside it; `real` is a master that is a real profile: `{ id, downloads }`. */
export function controlScene(context, defaults = {}, real) {
  const s = scene(context, { STUB_PROFILE: CLONE, ...defaults });
  const placed = layout(s, real);
  /** A stub Chrome on the clone root that no lifecycle state records. */
  const holdClone = (mode = "headed") => {
    const args = mode === "headless" ? ["--headless=new"] : [];
    const child = spawn(join(s.home, APP), [`--user-data-dir=${placed.root}`, ...args], {
      stdio: "ignore",
      env: s.vars({ STUB_ACK: "", STUB_ALIVE: "30" }),
    });
    s.spawned.push(child.pid);
    spawnSync("sleep", ["0.3"]);
    return child.pid;
  };
  /** One `clone-control.sh run`; `extra` replaces the stub's environment. */
  const run = (shell, extra = {}) => {
    const result = spawnSync(shell, [script, "run", s.state, s.record, NAMESPACE], {
      encoding: "utf8",
      env: s.vars(extra),
      timeout: 120_000,
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { ...s, ...placed, ...accessors(placed.control), holdClone, run };
}
