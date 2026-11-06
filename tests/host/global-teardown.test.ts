import { describe, expect, test } from "vite-plus/test";
import { leakedPresence } from "./global-teardown.ts";

// The P2.2 presence leaked into ~/Downloads once; the host run now fails if it happens again.
const missing = async (path: string) => {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};

describe("host teardown guard", () => {
  test("stats only ~/Downloads/RECnRun/poc and reports it when present", async () => {
    const seen: string[] = [];
    const stat = async (path: string) => void seen.push(path);
    await expect(leakedPresence("/Users/owner", stat)).resolves.toBe(
      "/Users/owner/Downloads/RECnRun/poc",
    );
    expect(seen).toEqual(["/Users/owner/Downloads/RECnRun/poc"]);
  });

  test("reports nothing when the folder does not exist", async () => {
    await expect(leakedPresence("/Users/owner", missing)).resolves.toBeUndefined();
  });

  test("propagates any other stat failure", async () => {
    const denied = async () =>
      Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(leakedPresence("/Users/owner", denied)).rejects.toThrow("EACCES");
  });
});
