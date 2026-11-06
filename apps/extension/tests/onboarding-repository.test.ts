import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { pocOnboardingStore } from "@/storage/poc-onboarding-repository";

const OP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operation = { operationId: OP, basesDir: "/Users/me/Bases", baseName: "base-v1", clones: 2 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  fakeBrowser.reset();
});

describe("pocOnboardingStore operation", () => {
  test("keeps the last operation the page asked for", async () => {
    const store = pocOnboardingStore();
    expect(await store.operation.read()).toBeUndefined();
    await store.operation.write(operation);
    expect(await pocOnboardingStore().operation.read()).toEqual(operation);
  });

  test.each([
    ["a string", "nope"],
    ["an operation with an extra key", { ...operation, extra: 1 }],
    ["clones out of range", { ...operation, clones: 9 }],
  ])("reads %s as no operation", async (_name, stored) => {
    await fakeBrowser.storage.local.set({ pocOnboarding: stored });
    expect(await pocOnboardingStore().operation.read()).toBeUndefined();
  });
});

describe("pocOnboardingStore written", () => {
  test("remembers the ids it was given, and only those", async () => {
    const { written } = pocOnboardingStore();
    expect(await written.has(OP)).toBe(false);
    await written.add(OP);
    expect(await written.has(OP)).toBe(true);
    expect(await written.has(id(1))).toBe(false);
  });

  test("keeps the sixteen newest ids", async () => {
    const { written } = pocOnboardingStore();
    for (let n = 1; n <= 17; n++) await written.add(id(n));
    expect(await written.has(id(1))).toBe(false);
    expect(await written.has(id(2))).toBe(true);
    expect(await written.has(id(17))).toBe(true);
  });

  test("starts over from a stored value that is not a list of ids", async () => {
    await fakeBrowser.storage.local.set({ pocPrepareWritten: { not: "a list" } });
    const { written } = pocOnboardingStore();
    expect(await written.has(OP)).toBe(false);
    await written.add(OP);
    expect(await written.has(OP)).toBe(true);
  });
});
