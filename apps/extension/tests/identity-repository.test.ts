import type { Identity } from "@recnrun/domain";
import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { identityRepository } from "@/storage/identity-repository";

const KEY = "identities";
const alice: Identity = {
  id: "a",
  label: "Alice",
  url: "https://app.example/",
  created: 1,
};

beforeEach(() => {
  fakeBrowser.reset();
});

test("keeps the identities under their own local key, validated", async () => {
  expect(await identityRepository.list()).toEqual([]);
  await identityRepository.update((list) => [...list, alice]);
  expect(await identityRepository.list()).toEqual([alice]);
  expect(await fakeBrowser.storage.local.get(KEY)).toEqual({ [KEY]: [alice] });
});

test("two changes at once both land", async () => {
  await Promise.all([
    identityRepository.update((list) => [...list, alice]),
    identityRepository.update((list) => [...list, { ...alice, id: "b" }]),
  ]);
  expect((await identityRepository.list()).map(({ id }) => id)).toEqual(["a", "b"]);
});

test("refuses to store or read a list that does not match the schema", async () => {
  await expect(identityRepository.update((list) => [...list, alice, alice])).rejects.toThrow(
    "The identities do not match the current schema.",
  );
  expect(await identityRepository.list()).toEqual([]);
  await fakeBrowser.storage.local.set({ [KEY]: [{ ...alice, url: "file:///x" }] });
  await expect(identityRepository.list()).rejects.toThrow("current schema");
});
