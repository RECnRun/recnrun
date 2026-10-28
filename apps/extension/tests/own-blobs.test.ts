import { expect, test } from "vite-plus/test";
import { ownBlobs } from "@/background/workspace/own-blobs";

/** Whether `copy` is another Blob of the same kind, type, and bytes as `original`. */
async function expectCopyOf(copy: unknown, original: Blob) {
  expect(copy).toBeInstanceOf(original instanceof File ? File : Blob);
  expect(copy).not.toBe(original);
  const blob = copy as Blob;
  expect(blob.type).toBe(original.type);
  await expect(blob.text()).resolves.toBe(await original.text());
}

test("replaces every Blob a record holds, at any depth, with a copy of the same type and bytes", async () => {
  const top = new Blob(["top"], { type: "text/plain" });
  const inList = new Blob(["in a list"]);
  const mapKey = new Blob(["a key"]);
  const mapValue = new Blob(["a value"], { type: "application/json" });
  const inSet = new Blob(["in a set"]);
  const at = new Date(5);
  const bytes = new Uint8Array([1, 2]);
  const value = {
    list: [inList, 1],
    map: new Map<unknown, unknown>([
      ["first", mapValue],
      [mapKey, "second"],
    ]),
    set: new Set<unknown>(["a", inSet]),
    deep: { at, bytes },
  };
  const first: { value: unknown } = { value: top };
  const second = { key: 2, value };
  await ownBlobs([first, second]);

  await expectCopyOf(first.value, top);
  await expectCopyOf(value.list[0], inList);
  expect(value.list[1]).toBe(1);
  const [firstKey, secondKey] = [...value.map.keys()];
  expect(firstKey).toBe("first");
  await expectCopyOf(value.map.get("first"), mapValue);
  await expectCopyOf(secondKey, mapKey);
  expect(value.map.get(secondKey)).toBe("second");
  const [plain, blob] = [...value.set];
  expect(plain).toBe("a");
  await expectCopyOf(blob, inSet);
  // Values that are not Blobs stay the very same objects.
  expect(value.deep.at).toBe(at);
  expect(value.deep.bytes).toBe(bytes);
  expect(second.key).toBe(2);
});

test("a File stays a File with its name and date", async () => {
  const file = new File(["data"], "notes.txt", { type: "text/plain", lastModified: 1_234 });
  const value = { file };
  await ownBlobs([{ value }]);
  const copy = value.file;
  await expectCopyOf(copy, file);
  expect(copy).toMatchObject({ name: "notes.txt", lastModified: 1_234 });
});

test("visits a value that refers to itself once", async () => {
  const blob = new Blob(["loop"]);
  const loop: { self?: unknown; blob: Blob } = { blob };
  loop.self = loop;
  await ownBlobs([{ value: loop }]);
  expect(loop.self).toBe(loop);
  await expectCopyOf(loop.blob, blob);
});
