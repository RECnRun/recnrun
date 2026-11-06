import { describe, expect, test } from "vite-plus/test";
import { conclusive, InconclusiveSearchError } from "./browser/fixtures/x-display.ts";

// xdotool search exits on BadWindow when a window closes mid-search; that must not read as "no windows".
describe("x-display search outcomes", () => {
  test("retries inconclusive searches and returns the first conclusive result", async () => {
    const results = [undefined, undefined, "42"];
    await expect(conclusive(async () => results.shift(), 1_000, 1)).resolves.toBe("42");
    expect(results).toEqual([]);
  });

  test("an empty result is conclusive: no window matched", async () => {
    await expect(conclusive(async () => "", 1_000, 1)).resolves.toBe("");
  });

  test("throws when the search stays inconclusive until the deadline", async () => {
    await expect(conclusive(async () => undefined, 20, 1)).rejects.toBeInstanceOf(
      InconclusiveSearchError,
    );
  });
});
