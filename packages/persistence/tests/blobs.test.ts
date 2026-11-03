import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BLOB_BYTES } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { BlobStoreError, openBlobStore } from "../src/index.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);
const JSON_META = { mime: "application/json", encoding: "utf8" } as const;

let home = "";
let folder = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-blobs-"));
  folder = join(home, "sessions", "S1", "blobs");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("stores a body under its sha256 and reads the same bytes back", async () => {
  const store = await openBlobStore({ folder });
  const body = bytes('{"ok":true}');
  const ref = await store.put(body, JSON_META);
  expect(ref).toEqual({
    sha256: sha256(body),
    ...JSON_META,
    size: body.length,
    condition: "captured",
  });
  expect(await readFile(join(folder, ref.sha256))).toEqual(Buffer.from(body));
  expect(await store.read(ref.sha256)).toEqual(Buffer.from(body));
  expect(store.maxBytes).toBe(DEFAULT_MAX_BLOB_BYTES);
});

test("the same body stored twice is one file, and no temporary file is left", async () => {
  const store = await openBlobStore({ folder });
  const body = bytes("same body");
  const [first, second] = await Promise.all([
    store.put(body, JSON_META),
    store.put(body, JSON_META),
  ]);
  expect(second).toEqual(first);
  expect(await readdir(folder)).toEqual([first.sha256]);
});

test("a body above the cap keeps its first bytes, its original size, and is truncated", async () => {
  const store = await openBlobStore({ folder, maxBytes: 8 });
  const body = Uint8Array.from({ length: 20 }, (_, index) => index);
  const ref = await store.put(body, { mime: "image/png", encoding: "binary" });
  const kept = body.slice(0, 8);
  expect(ref).toEqual({
    sha256: sha256(kept),
    mime: "image/png",
    encoding: "binary",
    size: 20,
    condition: "truncated",
  });
  expect(await store.read(ref.sha256)).toEqual(Buffer.from(kept));
});

test("a body exactly at the cap is captured whole", async () => {
  const store = await openBlobStore({ folder, maxBytes: 4 });
  const ref = await store.put(bytes("abcd"), JSON_META);
  expect(ref).toMatchObject({ size: 4, condition: "captured" });
});

test.skipIf(process.platform === "win32")("blobs are private to the user", async () => {
  const store = await openBlobStore({ folder });
  const ref = await store.put(bytes("secret body"), JSON_META);
  expect((await stat(folder)).mode & 0o777).toBe(0o700);
  expect((await stat(join(folder, ref.sha256))).mode & 0o777).toBe(0o600);
});

test("a name that is not a sha256 is refused before touching the disk", async () => {
  const store = await openBlobStore({ folder });
  await expect(store.read("../../events.jsonl")).rejects.toMatchObject({
    name: "BlobStoreError",
    code: "invalid-name",
  });
});

test("a missing blob is not-found, and a blob whose bytes changed is corrupt", async () => {
  const store = await openBlobStore({ folder });
  await expect(store.read("0".repeat(64))).rejects.toMatchObject({ code: "not-found" });
  const ref = await store.put(bytes("original"), JSON_META);
  await writeFile(join(folder, ref.sha256), "tampered");
  await expect(store.read(ref.sha256)).rejects.toMatchObject({ code: "corrupt" });
  await expect(store.put(bytes("original"), JSON_META)).rejects.toBeInstanceOf(BlobStoreError);
});

test("a cap that is not a positive integer is refused", async () => {
  await expect(openBlobStore({ folder, maxBytes: 0 })).rejects.toThrow(RangeError);
  await expect(openBlobStore({ folder, maxBytes: 1.5 })).rejects.toThrow(RangeError);
});
