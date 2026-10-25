import { expect, test } from "vite-plus/test";
import { coalesceReads } from "@/views/coalesce-reads";

/** A read the test settles by hand, counting how many times it was started. */
function manualRead() {
  const pending: Array<{ resolve: (value: number) => void; reject: (error: Error) => void }> = [];
  const read = () =>
    new Promise<number>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return {
    read,
    started: () => pending.length,
    settle: async (value: number) => {
      pending[pending.length - 1]?.resolve(value);
      await new Promise((done) => setTimeout(done, 0));
    },
    fail: async () => {
      pending[pending.length - 1]?.reject(new Error("tabs unavailable"));
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

test("a burst of refreshes during a read reads once more after it, not once per refresh", async () => {
  const reads = manualRead();
  const shown: number[] = [];
  const scheduler = coalesceReads(reads.read, (value) => shown.push(value));
  scheduler.refresh();
  for (let event = 0; event < 5; event += 1) scheduler.refresh();
  expect(reads.started()).toBe(1);

  await reads.settle(1);
  expect(reads.started()).toBe(2);
  await reads.settle(2);
  expect(reads.started()).toBe(2);
  expect(shown).toEqual([1, 2]);
});

test("a refresh with no read in flight reads at once", async () => {
  const reads = manualRead();
  const shown: number[] = [];
  const scheduler = coalesceReads(reads.read, (value) => shown.push(value));
  scheduler.refresh();
  await reads.settle(1);
  scheduler.refresh();
  expect(reads.started()).toBe(2);
  await reads.settle(2);
  expect(shown).toEqual([1, 2]);
});

test("a failed read shows nothing and still honors the refresh that waited for it", async () => {
  const reads = manualRead();
  const shown: number[] = [];
  const scheduler = coalesceReads(reads.read, (value) => shown.push(value));
  scheduler.refresh();
  scheduler.refresh();
  await reads.fail();
  expect(reads.started()).toBe(2);
  await reads.settle(2);
  expect(shown).toEqual([2]);
});

test("after stop, the read in flight shows nothing and the waiting refresh never reads", async () => {
  const reads = manualRead();
  const shown: number[] = [];
  const scheduler = coalesceReads(reads.read, (value) => shown.push(value));
  scheduler.refresh();
  scheduler.refresh();
  scheduler.stop();
  await reads.settle(1);
  expect(shown).toEqual([]);
  expect(reads.started()).toBe(1);
});
