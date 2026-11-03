import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { loadDataset } from "@/dataset";

let folder = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "recnrun-dataset-"));
  await mkdir(join(folder, "datasets"));
  await writeFile(join(folder, "flow.yaml"), "");
});
afterEach(() => rm(folder, { recursive: true, force: true }));

const write = (name: string, text: string) =>
  writeFile(join(folder, "datasets", `${name}.json`), text);

test("a folder or its flow file finds datasets/<name>.json and validates it", async () => {
  await write("default", JSON.stringify({ schemaVersion: 1, inputs: { name: "Ada" } }));
  const expected = { schemaVersion: 1, inputs: { name: "Ada" } };
  expect(await loadDataset(folder, "default")).toEqual(expected);
  expect(await loadDataset(join(folder, "flow.yaml"), "default")).toEqual(expected);
});

test("a missing dataset names the file it looked for", async () => {
  await expect(loadDataset(folder, "nightly")).rejects.toThrow(
    /datasets\/nightly\.json: the dataset cannot be read/,
  );
});

test("a dataset that is not JSON or not a dataset is rejected", async () => {
  await write("broken", "{");
  await write("wrong", JSON.stringify({ schemaVersion: 1 }));
  await expect(loadDataset(folder, "broken")).rejects.toThrow(/is not JSON/);
  await expect(loadDataset(folder, "wrong")).rejects.toThrow(/not a valid dataset/);
});

test("a dataset name that is not a slug never becomes a path", async () => {
  await expect(loadDataset(folder, "../flow")).rejects.toThrow(/a dataset name is a slug/);
});
