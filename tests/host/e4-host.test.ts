import { describe, expect, test } from "vite-plus/test";
import { plutilPreference } from "./fixtures/e4-host.ts";

// Codex P2 finding 5: plutil's missing key is a measured null; a plutil that cannot run is not.
const failing = (error: object) => () => Promise.reject(Object.assign(new Error("plutil"), error));

describe("E4 host native reader", () => {
  test("returns the folder plutil prints", async () => {
    const run = async () => ({ stdout: "/folder\n" });
    await expect(plutilPreference("/root", run)).resolves.toBe("/folder");
  });

  test("reads a missing key as no folder", async () => {
    const run = failing({ code: 1, stderr: "No value at that key path or invalid key path" });
    await expect(plutilPreference("/root", run)).resolves.toBeNull();
  });

  test("propagates a plutil that cannot start", async () => {
    const run = failing({ code: "ENOENT", syscall: "spawn plutil" });
    await expect(plutilPreference("/root", run)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("propagates another plutil failure", async () => {
    const run = failing({ code: 1, stderr: "Preferences: file does not exist" });
    await expect(plutilPreference("/root", run)).rejects.toMatchObject({ code: 1 });
  });
});
