import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY, NAMESPACE, announce, presence } from "./lab.mjs";
import { baseScene, environment } from "./base-lab.mjs";
import { MASTER, masterBlock } from "./clone-open-lab.mjs";

const script = fileURLToPath(new URL("./provision.sh", import.meta.url));
export const OPERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** The request the extension writes (PrepareRequestSchema), in JSON.stringify's key order. */
export const requestText = (overrides = {}) =>
  JSON.stringify({
    operationId: OPERATION,
    kind: "prepare-workers",
    basesDir: "",
    baseName: "base-v1",
    clones: 2,
    namespace: NAMESPACE,
    masterProfileId: MASTER,
    masterIdentity: IDENTITY,
    createdAt: 1_800_000_000_000,
    ...overrides,
  });

/** The status without its clock, and the proof that the file is the closed layout. */
export function shape(status) {
  const { raw, updatedAt, ...rest } = status;
  assert.equal(raw, JSON.stringify({ ...rest, updatedAt }), "key order and no extra bytes");
  assert.equal(Number.isSafeInteger(updatedAt) && updatedAt > 1_700_000_000_000, true);
  return rest;
}

/** A home with a stub Chrome, a master's Downloads root and presence, a record, and a state folder. */
export function provisionScene(context, { downloads: given, namespace = NAMESPACE } = {}) {
  const s = baseScene(context);
  const state = join(s.home, "state");
  const record = join(s.home, "launcher.record");
  const downloads = given ?? join(s.home, "master-downloads");
  const ops = join(downloads, "RECnRun/poc", namespace, "ops");
  mkdirSync(state);
  mkdirSync(join(s.home, "Master"));
  // A browser lab passes the Downloads root of its real master and writes the record itself.
  if (given === undefined) announce(downloads, presence(MASTER));
  mkdirSync(ops, { recursive: true });
  writeFileSync(record, `${masterBlock(s.home)}\n`);
  const folder = (id = OPERATION) => join(ops, id);
  const read = (name, id = OPERATION) => readFileSync(join(folder(id), name), "utf8");
  return {
    ...s,
    state,
    record,
    ops,
    folder,
    /** Writes the request of an operation, its bases folder being `bases` of the home by default. */
    request: (overrides = {}, id = OPERATION) => {
      mkdirSync(folder(id), { recursive: true });
      writeFileSync(
        join(folder(id), "request.json"),
        requestText({ operationId: id, basesDir: s.bases, ...overrides }),
      );
    },
    status: (id = OPERATION) => {
      const raw = read("status.json", id);
      return { raw, ...JSON.parse(raw) };
    },
    hasStatus: (id = OPERATION) => existsSync(join(folder(id), "status.json")),
    stateText: () => readFileSync(join(state, "ops", OPERATION), "utf8"),
    /** One `provision.sh run`; the stub Chrome acks as `extra` says (STUB_ACK, STUB_CLONE). */
    run: (shell, extra = {}, args) => {
      const vars = environment(s.home, "base-v1", {
        STUB_ROOT: downloads,
        STUB_NS: namespace,
        ...extra,
      });
      const result = spawnSync(shell, [script, ...(args ?? ["run", state, record, namespace])], {
        encoding: "utf8",
        env: { ...vars, PATH: `${join(s.home, "ps-stub")}:${process.env.PATH}` },
        timeout: 120_000,
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    },
    recordText: () => readFileSync(record, "utf8"),
    setRecord: (text) => writeFileSync(record, text),
  };
}
