import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { flowToYaml, openFlowStore, type FlowStore } from "../src/index.ts";
import { spikeFlow } from "./flow-fixtures.ts";

let home = "";
let store: FlowStore;
const folder = () => join(home, ".recnrun", "flows", "form-submit");
const file = (name: string) => join(folder(), name);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-flow-reads-"));
  store = await openFlowStore({ home });
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

/** Saves v1, then leaves a v2 save interrupted after flow.yaml, before its manifest. */
async function interruptedSave() {
  const first = await store.saveFlow(spikeFlow());
  const committed = await readFile(file("manifest.json"), "utf8");
  const yaml = await readFile(file("flow.yaml"), "utf8");
  const second = await store.saveFlow({ ...spikeFlow(), name: "Renamed" });
  await writeFile(file("manifest.json"), committed);
  return { first, second, yaml };
}

test("get answers the revision the manifest commits, not a flow.yaml a save left behind", async () => {
  const { first } = await interruptedSave();
  const stored = await store.get("form-submit");
  expect(stored.revision).toBe(first.revision);
  expect(stored.flow.name).toBe("Submit the fixture form");
  expect(stored.manifest).toEqual(first.manifest);
});

test("get puts flow.yaml and requirements.md back to the committed revision after an interrupted save", async () => {
  const { yaml } = await interruptedSave();
  await store.get("form-submit");
  expect(await readFile(file("flow.yaml"), "utf8")).toBe(yaml);
  expect(await readFile(file("requirements.md"), "utf8")).toContain(
    "# Requirements of Submit the fixture form",
  );
});

test("saving the committed flow again repairs flow.yaml even though nothing changed", async () => {
  const { yaml } = await interruptedSave();
  expect(await store.saveFlow(spikeFlow())).toMatchObject({ changed: false });
  expect(await readFile(file("flow.yaml"), "utf8")).toBe(yaml);
});

test("a flow.yaml edited outside the store is never overwritten by a read", async () => {
  const saved = await store.saveFlow(spikeFlow());
  const edited = flowToYaml({ ...spikeFlow(), name: "Edited by hand" });
  await writeFile(file("flow.yaml"), edited);
  const stored = await store.get("form-submit");
  expect(stored.revision).toBe(saved.revision);
  expect(stored.flow.name).toBe("Submit the fixture form");
  expect(await readFile(file("flow.yaml"), "utf8")).toBe(edited);
});

test("a read waits for a save in progress instead of mixing two versions", async () => {
  await store.saveFlow(spikeFlow());
  const saving = store.saveFlow({ ...spikeFlow(), name: "Renamed" });
  const stored = await store.get("form-submit");
  const saved = await saving;
  expect(stored.revision).toBe(saved.revision);
  expect(stored.manifest).toEqual(saved.manifest);
});

test("a manifest that names another flow is refused", async () => {
  await store.saveFlow(spikeFlow());
  const manifest = JSON.parse(await readFile(file("manifest.json"), "utf8")) as { id: string };
  await writeFile(file("manifest.json"), JSON.stringify({ ...manifest, id: "other-flow" }));
  await expect(store.get("form-submit")).rejects.toMatchObject({ code: "invalid" });
});
