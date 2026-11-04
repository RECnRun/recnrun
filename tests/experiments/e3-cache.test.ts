import { describe, expect, it } from "vite-plus/test";
import { cacheRun, VERSIONS } from "./e3-cache.ts";
import type { CacheIo, Read } from "./e3-cache.ts";

const ok = (text: string): Read => ({ ok: true, status: 200, text });

/** An in-memory probe whose reader answers the previous bytes `staleReads` times after the writes listed. */
function probe(stale: { after: number[]; staleReads: number } = { after: [], staleReads: 0 }) {
  let written: string[] = [];
  let pending = 0;
  const waits: number[] = [];
  const io: CacheIo = {
    write: async (text) => {
      written = [...written, text];
      pending = stale.after.includes(written.length - 1) ? stale.staleReads : 0;
    },
    read: async (cache) => {
      if (pending > 0 && cache !== "no-store") {
        pending -= 1;
        return ok(written.at(-2) ?? "");
      }
      return ok(written.at(-1) ?? "");
    },
    wait: async () => {
      waits.push(written.length);
    },
  };
  return { io, waits };
}

describe("cacheRun", () => {
  it("passes a reader that shows every change on its first read", async () => {
    const { io, waits } = probe();
    const run = await cacheRun(io);
    expect(run.problems).toEqual([]);
    expect(waits).toEqual([1, 2, 2, 3, 3, 4]);
    expect(run.observation).toMatchObject({ before: { text: VERSIONS[0] } });
  });

  it("fails a reader that answers the old bytes once after a change", async () => {
    const { io } = probe({ after: [1, 2, 3], staleReads: 1 });
    const run = await cacheRun(io);
    expect(run.problems).toEqual([
      "the first read after version B returned version A",
      "the first read after version C returned version B",
      "the first read after version D returned version C",
    ]);
  });

  it("fails when only the last change is stale once, so one sampled change is not enough", async () => {
    const { io } = probe({ after: [3], staleReads: 1 });
    const run = await cacheRun(io);
    expect(run.problems).toEqual(["the first read after version D returned version C"]);
    expect(run.observation).toMatchObject({
      changes: [
        { version: "B", first: { text: VERSIONS[1] } },
        { version: "C", first: { text: VERSIONS[2] } },
        { version: "D", first: { text: VERSIONS[2] }, noStore: { text: VERSIONS[3] } },
      ],
    });
  });

  it("fails a reader that keeps the old bytes past the next poll", async () => {
    const { io } = probe({ after: [1], staleReads: 2 });
    const run = await cacheRun(io);
    expect(run.problems).toEqual([
      "the first read after version B returned version A",
      "the read one poll after version B returned version A",
    ]);
  });

  it("fails a read that errors", async () => {
    const { io } = probe();
    const failing: CacheIo = {
      ...io,
      read: async () => ({ ok: false, error: { name: "TypeError", message: "Failed to fetch" } }),
    };
    const run = await cacheRun(failing);
    expect(run.problems[0]).toBe("the first read did not return version A");
  });
});
