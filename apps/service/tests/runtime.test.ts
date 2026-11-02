import { readFile } from "node:fs/promises";
import type { JournalWriter, RotatingLog } from "@recnrun/persistence";
import { expect, test, vi } from "vite-plus/test";
import { connectHost, isLoopbackHost } from "@/egress";
import { createJournalRegistry, ServiceStoppingError } from "@/journals";
import { createLogger } from "@/logger";
import { stopOnSignals } from "@/signals";
import { SERVICE_VERSION } from "@/version";

test("SERVICE_VERSION matches package.json", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(SERVICE_VERSION).toBe(manifest.version);
});

test("the logger writes one JSON line per event and survives a failed write", async () => {
  const lines: string[] = [];
  const log: RotatingLog = {
    path: "service.log",
    append: async (line) => {
      lines.push(line);
      if (lines.length === 2) throw new Error("disk full");
    },
    close: async () => undefined,
  };
  const time = "2026-11-02T10:00:00.000Z";
  const logger = createLogger(log, () => new Date(time));
  logger.info("service.started", { port: 4700 });
  logger.warn("http.refused", { status: 403 });
  logger.error("journal.drain-failed");
  await logger.close();
  const { pid } = process;
  expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
    { time, level: "info", event: "service.started", pid, port: 4700 },
    { time, level: "warn", event: "http.refused", pid, status: 403 },
    { time, level: "error", event: "journal.drain-failed", pid },
  ]);
  expect(lines.every((line) => line.endsWith("}\n"))).toBe(true);
});

function fakeWriter(path: string, close: () => Promise<void> = async () => undefined) {
  const writer: JournalWriter = { path, append: async () => undefined, close };
  return writer;
}

test("drain closes every open journal, reports failures, and refuses new ones", async () => {
  const registry = createJournalRegistry(async (path) =>
    path === "bad"
      ? fakeWriter(path, async () => Promise.reject(new Error("EIO")))
      : fakeWriter(path),
  );
  await registry.open("a");
  const closed = await registry.open("b");
  await registry.open("bad");
  await closed.close();
  expect(registry.openCount).toBe(2);
  expect(await registry.drain()).toEqual(["Error: EIO"]);
  expect(registry.openCount).toBe(0);
  await expect(registry.open("c")).rejects.toThrow(ServiceStoppingError);
});

test("a journal that opens while draining is closed, not leaked", async () => {
  let finishOpen: (writer: JournalWriter) => void = () => undefined;
  const close = vi.fn(async () => undefined);
  const registry = createJournalRegistry(
    () =>
      new Promise<JournalWriter>((resolve) => {
        finishOpen = resolve;
      }),
  );
  const opening = registry.open("late");
  await registry.drain();
  finishOpen(fakeWriter("late", close));
  await expect(opening).rejects.toThrow(ServiceStoppingError);
  expect(close).toHaveBeenCalledOnce();
  expect(registry.openCount).toBe(0);
});

function signalSource() {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    once: (signal: string, listener: () => void) => listeners.set(signal, listener),
  };
}

test("a signal stops the service once and then exits 0", async () => {
  const source = signalSource();
  const stop = vi.fn(async () => undefined);
  const exits: number[] = [];
  stopOnSignals({ stop }, (code) => exits.push(code), source);
  source.listeners.get("SIGTERM")?.();
  source.listeners.get("SIGINT")?.();
  await vi.waitFor(() => expect(exits).toEqual([0]));
  expect(stop).toHaveBeenCalledOnce();
});

test("a stop that fails exits 1", async () => {
  const source = signalSource();
  const exits: number[] = [];
  const stop = async () => Promise.reject(new Error("stuck"));
  stopOnSignals({ stop }, (code) => exits.push(code), source);
  source.listeners.get("SIGINT")?.();
  await vi.waitFor(() => expect(exits).toEqual([1]));
});

test.each([
  ["localhost", true],
  ["LOCALHOST", true],
  ["127.0.0.1", true],
  ["127.8.9.10", true],
  ["::1", true],
  ["[::1]", true],
  ["127.example.com", false],
  ["203.0.113.1", false],
  ["example.com", false],
])("%s is loopback: %s", (host, loopback) => {
  expect(isLoopbackHost(host)).toBe(loopback);
});

test.each([
  [[80, "203.0.113.1"], "203.0.113.1"],
  [[80], "localhost"],
  [["80", "example.com"], "example.com"],
  [["/tmp/ipc.sock"], undefined],
  [[{ port: 443, host: "example.com" }], "example.com"],
  [[{ port: 443 }], "localhost"],
  [[{ path: "/tmp/ipc.sock" }], undefined],
  [[[{ port: 443, host: "example.com" }, () => undefined]], "example.com"],
])("connect(%j) targets %s", (args, host) => {
  expect(connectHost(args)).toBe(host);
});
