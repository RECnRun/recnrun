import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { guardSignals, SIGNAL_EXIT_CODES } from "@/signals";

function setup(stop: () => Promise<void> = async () => undefined) {
  const source = new EventEmitter();
  const exits: number[] = [];
  const stopSpy = vi.fn(stop);
  const guard = guardSignals(stopSpy, (code) => exits.push(code), source);
  return { source, exits, stop: stopSpy, guard };
}

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("%s stops the owned service before exiting with %i", async (signal, code) => {
  const { source, exits, stop } = setup();
  source.emit(signal);
  await vi.waitFor(() => expect(exits).toEqual([code]));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(SIGNAL_EXIT_CODES[signal]).toBe(code);
});

test("a second signal while stopping neither stops again nor exits twice", async () => {
  const { source, exits, stop } = setup();
  source.emit("SIGTERM");
  source.emit("SIGINT");
  await vi.waitFor(() => expect(exits).toEqual([143]));
  expect(stop).toHaveBeenCalledTimes(1);
});

test("a stop that fails still exits with the signal's code", async () => {
  const { source, exits } = setup(async () => {
    throw new Error("lease busy");
  });
  source.emit("SIGINT");
  await vi.waitFor(() => expect(exits).toEqual([130]));
});

test("after release the signals are the process's own again", () => {
  const { source, exits, stop, guard } = setup();
  expect(source.listenerCount("SIGINT")).toBe(1);
  expect(source.listenerCount("SIGTERM")).toBe(1);
  guard.release();
  expect(source.listenerCount("SIGINT")).toBe(0);
  expect(source.listenerCount("SIGTERM")).toBe(0);
  expect(stop).not.toHaveBeenCalled();
  expect(exits).toEqual([]);
});
