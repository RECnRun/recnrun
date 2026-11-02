import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileBinding } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { BindingsFileError, openBindingsStore } from "../src/index.ts";

const ana: ProfileBinding = {
  name: "Ana",
  userDataDir: "/profiles/ana",
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/ana-1",
  browserContextIds: ["C1"],
  chrome: "Chrome/156.0.8078.79",
  createdAt: "2026-11-02T10:00:00.000Z",
  lastSeenAt: "2026-11-02T10:00:00.000Z",
};
const bob: ProfileBinding = {
  ...ana,
  name: "Bob",
  userDataDir: "/profiles/bob",
  wsEndpoint: "ws://127.0.0.1:9333/devtools/browser/bob-1",
};

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test("lives in <home>/.recnrun/bindings.json, never in a flow folder", () => {
  expect(openBindingsStore({ home }).path).toBe(join(home, ".recnrun", "bindings.json"));
});

test("a missing file is an empty list", async () => {
  expect(await openBindingsStore({ home }).list()).toEqual([]);
});

test("round trip: save, replace by name, remove", async () => {
  const store = openBindingsStore({ home });
  await store.save(ana);
  await store.save(bob);
  const seen = { ...ana, lastSeenAt: "2026-11-02T11:00:00.000Z" };
  await store.save(seen);
  expect(await openBindingsStore({ home }).list()).toEqual([seen, bob]);
  expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({
    schemaVersion: 1,
    bindings: [seen, bob],
  });
  expect(await store.remove("Ana")).toBe(true);
  expect(await store.remove("Ana")).toBe(false);
  expect(await store.list()).toEqual([bob]);
});

test("the file is 0600 and its folder 0700", async () => {
  const store = openBindingsStore({ home });
  await mkdir(join(home, ".recnrun"), { mode: 0o755 });
  await store.save(ana);
  expect(await mode(store.path)).toBe(0o600);
  expect(await mode(join(home, ".recnrun"))).toBe(0o700);
});

test("writes atomically: no temporary file is left beside it", async () => {
  const store = openBindingsStore({ home });
  await store.save(ana);
  await store.save(bob);
  expect(await readdir(join(home, ".recnrun"))).toEqual(["bindings.json"]);
});

test("refuses to write an invalid binding and leaves the file as it was", async () => {
  const store = openBindingsStore({ home });
  await store.save(ana);
  await expect(store.save({ ...bob, name: " padded " })).rejects.toThrow(/binding name/);
  expect(await store.list()).toEqual([ana]);
  expect(await readdir(join(home, ".recnrun"))).toEqual(["bindings.json"]);
});

test.each([
  ["text that is not JSON", "{ not json", /not JSON/],
  [
    "a file of another shape",
    JSON.stringify({ schemaVersion: 1, bindings: [{ name: "x" }] }),
    /is not a valid bindings file/,
  ],
  ["duplicate names", JSON.stringify({ schemaVersion: 1, bindings: [ana, ana] }), /unique/],
])("a corrupt file (%s) is reported with its path and never overwritten", async (_, text, why) => {
  const store = openBindingsStore({ home });
  await mkdir(join(home, ".recnrun"));
  await writeFile(store.path, text);
  const failure = store.list();
  await expect(failure).rejects.toBeInstanceOf(BindingsFileError);
  await expect(failure).rejects.toThrow(store.path);
  await expect(failure).rejects.toThrow(why);
  await expect(store.save(bob)).rejects.toBeInstanceOf(BindingsFileError);
  expect(await readFile(store.path, "utf8")).toBe(text);
});

test("other read errors are not mistaken for a missing file", async () => {
  const store = openBindingsStore({ home });
  await mkdir(store.path, { recursive: true });
  await expect(store.list()).rejects.toThrow(/EISDIR/);
});
