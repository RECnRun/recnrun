import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  FlowStoreError,
  canonicalJson,
  flowFolderLayout,
  openFlowStore,
  type FlowStore,
} from "../src/index.ts";
import { filesBelow, spikeFlow } from "./flow-fixtures.ts";

let home = "";
let store: FlowStore;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 10, 0, clock++));
const open = () => openFlowStore({ home, now });
const flowsRoot = () => join(home, ".recnrun", "flows");
const folder = (id = "form-submit") => join(flowsRoot(), id);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-flows-"));
  clock = 0;
  store = await open();
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

test("a save writes the flow folder of source §12 and leaves no temporary file", async () => {
  const saved = await store.saveFlow(spikeFlow());
  expect(saved.changed).toBe(true);
  expect(await filesBelow(folder())).toEqual(
    [
      flowFolderLayout.flow,
      flowFolderLayout.manifest,
      flowFolderLayout.requirements,
      join(flowFolderLayout.revisions, `${saved.revision}.json`),
    ].toSorted(),
  );
  expect(await readFile(join(folder(), "requirements.md"), "utf8")).toBe(
    "# Requirements of Submit the fixture form\n\n- **CA-01**: The requester sees the submitted name in the status.\n",
  );
  expect(saved.manifest).toEqual({
    schemaVersion: 1,
    id: "form-submit",
    name: "Submit the fixture form",
    revision: saved.revision,
    status: "draft",
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    revisions: [{ revision: saved.revision, savedAt: "2026-11-02T10:00:00.000Z" }],
  });
});

test("get reads flow.yaml back to the saved revision, byte for byte", async () => {
  const saved = await store.saveFlow(spikeFlow());
  const yaml = await readFile(join(folder(), "flow.yaml"), "utf8");
  const stored = await store.get("form-submit");
  expect(stored.revision).toBe(saved.revision);
  expect(stored.manifest).toEqual(saved.manifest);
  expect(await store.saveFlow(stored.flow)).toMatchObject({ changed: false });
  expect(await readFile(join(folder(), "flow.yaml"), "utf8")).toBe(yaml);
  const revisionText = await readFile(
    join(folder(), "revisions", `${saved.revision}.json`),
    "utf8",
  );
  expect(revisionText).toBe(canonicalJson(stored.flow));
});

test("an edit writes a second revision and leaves the first unchanged", async () => {
  const first = await store.saveFlow(spikeFlow());
  const firstPath = join(folder(), "revisions", `${first.revision}.json`);
  const firstText = await readFile(firstPath, "utf8");
  const second = await store.saveFlow({ ...spikeFlow(), name: "Renamed" }, { status: "recorded" });
  expect(second.revision).not.toBe(first.revision);
  expect(await readFile(firstPath, "utf8")).toBe(firstText);
  expect(await store.listRevisions("form-submit")).toEqual([
    { revision: first.revision, savedAt: "2026-11-02T10:00:00.000Z" },
    { revision: second.revision, savedAt: "2026-11-02T10:00:01.000Z" },
  ]);
  expect(await store.getRevision("form-submit", first.revision)).toMatchObject({
    name: "Submit the fixture form",
  });
  expect(second.manifest).toMatchObject({ name: "Renamed", status: "recorded" });
  expect(second.manifest.createdAt).toBe(first.manifest.createdAt);
});

test("a status change alone keeps the revision history", async () => {
  const first = await store.saveFlow(spikeFlow());
  const second = await store.saveFlow(spikeFlow(), { status: "validated" });
  expect(second).toMatchObject({ changed: true, revision: first.revision });
  expect(second.manifest.revisions).toEqual(first.manifest.revisions);
});

test("writing a revision hash that holds different content throws", async () => {
  const saved = await store.saveFlow(spikeFlow());
  const path = join(folder(), "revisions", `${saved.revision}.json`);
  await writeFile(path, canonicalJson({ ...spikeFlow(), name: "Tampered" }));
  await rm(join(folder(), "manifest.json"));
  await expect(store.saveFlow(spikeFlow())).rejects.toMatchObject({
    code: "revision-conflict",
    path,
  });
  await expect(store.getRevision("form-submit", saved.revision)).rejects.toMatchObject({
    code: "revision-mismatch",
  });
});

test("an invalid flow is refused before anything is written", async () => {
  await expect(store.saveFlow({ ...spikeFlow(), steps: [{ id: "x" }] })).rejects.toBeInstanceOf(
    FlowStoreError,
  );
  expect(await filesBelow(join(home, ".recnrun"))).toEqual(["index.sqlite"]);
});

test("ids that are not slugs never reach the file system", async () => {
  await expect(store.get("../escape")).rejects.toMatchObject({ code: "not-found" });
  await expect(store.getRevision("form-submit", "../../x")).rejects.toMatchObject({
    code: "not-found",
  });
  await expect(store.get("absent")).rejects.toMatchObject({ code: "not-found" });
});

test("datasets live in datasets/<name>.json and are validated", async () => {
  await store.saveFlow(spikeFlow());
  const dataset = { schemaVersion: 1 as const, inputs: { name: "Ana" } };
  await store.saveDataset("form-submit", "ana", dataset);
  expect(await store.getDataset("form-submit", "ana")).toEqual(dataset);
  expect(await readFile(join(folder(), "datasets", "ana.json"), "utf8")).toBe(
    `${JSON.stringify(dataset, null, 2)}\n`,
  );
  await writeFile(join(folder(), "datasets", "bad.json"), "{");
  await expect(store.getDataset("form-submit", "bad")).rejects.toMatchObject({ code: "not-json" });
  await expect(store.saveDataset("absent", "ana", dataset)).rejects.toMatchObject({
    code: "not-found",
  });
});

test("a corrupt manifest is reported and the other flows still list", async () => {
  await store.saveFlow(spikeFlow());
  await store.saveFlow({ ...spikeFlow(), id: "other", name: "Other" });
  await store.saveFlow({ ...spikeFlow(), id: "third", name: "Third" });
  await writeFile(join(folder("other"), "manifest.json"), '{"schemaVersion":1');
  await writeFile(join(folder("third"), "manifest.json"), '{"schemaVersion":1}');
  await store.rebuildIndex();
  const { flows, problems } = await store.list();
  expect(flows.map(({ id }) => id)).toEqual(["form-submit"]);
  expect(problems).toEqual([
    expect.objectContaining({ code: "not-json", path: join(folder("other"), "manifest.json") }),
    expect.objectContaining({ code: "invalid", path: join(folder("third"), "manifest.json") }),
  ]);
  await expect(store.get("other")).rejects.toMatchObject({ code: "not-json" });
});

test("deleting index.sqlite and reopening rebuilds the catalog identically", async () => {
  await store.saveFlow(spikeFlow());
  await store.saveFlow({ ...spikeFlow(), id: "other", name: "Other" }, { status: "validated" });
  await store.saveFlow({ ...spikeFlow(), name: "Renamed" });
  const before = await store.list();
  expect(before.flows.map(({ id, name, status }) => [id, name, status])).toEqual([
    ["form-submit", "Renamed", "draft"],
    ["other", "Other", "validated"],
  ]);
  store.close();
  await rm(join(home, ".recnrun", "index.sqlite"));
  store = await open();
  expect(await store.list()).toEqual(before);
});

test("an index row that no longer validates is reported, and another index version is rebuilt", async () => {
  await store.saveFlow(spikeFlow());
  store.close();
  const indexPath = join(home, ".recnrun", "index.sqlite");
  const tamper = (sql: string) => {
    const db = new DatabaseSync(indexPath);
    db.exec(sql);
    db.close();
  };
  tamper("UPDATE flows SET status = 'done'");
  store = await open();
  expect(await store.list()).toEqual({
    flows: [],
    problems: [expect.objectContaining({ code: "invalid", path: indexPath })],
  });
  store.close();
  tamper("PRAGMA user_version = 0");
  store = await open();
  expect(await store.list()).toMatchObject({ flows: [{ id: "form-submit" }], problems: [] });
});

test("a folder whose manifest names another flow is reported", async () => {
  await store.saveFlow(spikeFlow());
  await cp(folder(), folder("copy"), { recursive: true });
  const { flows, problems } = await store.rebuildIndex();
  expect(flows.map(({ id }) => id)).toEqual(["form-submit"]);
  expect(problems).toEqual([
    expect.objectContaining({ code: "invalid", path: join(folder("copy"), "manifest.json") }),
  ]);
});
