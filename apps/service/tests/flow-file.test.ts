import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowToYaml } from "@recnrun/persistence";
import type { Flow } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { loadFlowFile } from "@/flow-file";

const flow = {
  schemaVersion: 1,
  id: "tiny",
  name: "Tiny",
  steps: [{ id: "open", action: "navigate", url: "http://127.0.0.1:4600/" }],
} as Flow;

let folder = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "recnrun-flow-file-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

test("a folder is read through its flow.yaml", async () => {
  await writeFile(join(folder, "flow.yaml"), flowToYaml(flow));
  expect(await loadFlowFile(folder)).toMatchObject({ id: "tiny" });
});

test("a .flow.json file is read as a flow", async () => {
  const file = join(folder, "tiny.flow.json");
  await writeFile(file, JSON.stringify(flow));
  expect(await loadFlowFile(file)).toMatchObject({ id: "tiny" });
});

test("a missing flow, an unreadable folder, and an invalid flow each name the path", async () => {
  await expect(loadFlowFile(join(folder, "nope"))).rejects.toThrow(/nope/);
  await mkdir(join(folder, "empty"));
  await expect(loadFlowFile(join(folder, "empty"))).rejects.toThrow(/flow\.yaml/);
  await writeFile(join(folder, "flow.yaml"), "id: 1\n");
  await expect(loadFlowFile(folder)).rejects.toThrow(/not a valid flow/);
});
