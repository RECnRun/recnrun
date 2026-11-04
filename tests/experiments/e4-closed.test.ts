import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeEnvironment } from "./e4-fake.ts";
import { closedProfileProblems, closedProfileSample } from "./e4-samples.ts";
import { launcherIo } from "./fixtures/e4-launcher.ts";

// Codex P2 finding 9: B stays listed right after it quits, then drops out once its presence expired.
const both = { code: 0, listed: ["A", "B"] };
const onlyA = { code: 0, listed: ["A"] };
const freshA = { reason: "fresh", listed: ["A"] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E4.b.closedProfile", () => {
  test("passes over a fake session: A and B after the quit, A alone after the expiry", async () => {
    await expect(closedProfileSample(fakeEnvironment())).resolves.toMatchObject({ ok: true });
  });

  test("fails when the run right after the quit exits 73 and lists nobody", async () => {
    vi.spyOn(launcherIo, "execFile").mockImplementationOnce((_file, _args, callback) => {
      callback(Object.assign(new Error("cannot write"), { code: 73 }), "", "cannot write");
    });
    const sample = await closedProfileSample(fakeEnvironment());
    expect(sample.ok).toBe(false);
    expect(sample.error).toContain("after the quit catalog.sh exited 73");
  });

  test("requires A and B right after the quit", () => {
    const seen = { afterQuit: onlyA, afterExpiry: onlyA, readByA: freshA };
    expect(closedProfileProblems(seen)).toEqual(["after the quit it lists A"]);
  });

  test("requires the run after the expiry to succeed and list only A", () => {
    const seen = {
      afterQuit: both,
      afterExpiry: { code: 75, listed: ["A", "B"] },
      readByA: freshA,
    };
    expect(closedProfileProblems(seen)).toEqual([
      "after expiry catalog.sh exited 75",
      "after expiry it lists A,B",
    ]);
  });

  test("requires A's read after the expiry to be fresh", () => {
    const seen = {
      afterQuit: both,
      afterExpiry: onlyA,
      readByA: { reason: "stale", listed: ["A"] },
    };
    expect(closedProfileProblems(seen)).toEqual(["A reads stale with A"]);
  });

  test("has no problem when every step holds", () => {
    expect(closedProfileProblems({ afterQuit: both, afterExpiry: onlyA, readByA: freshA })).toEqual(
      [],
    );
  });
});
