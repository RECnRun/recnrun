import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { openRotatingLog } from "../src/index.ts";

let folder = "";
beforeEach(async () => {
  folder = join(await mkdtemp(join(tmpdir(), "recnrun-logs-")), "logs");
});
afterEach(async () => {
  await rm(join(folder, ".."), { recursive: true, force: true });
});

const line = (n: number) => `${JSON.stringify({ n, pad: "x".repeat(20) })}\n`;

test("appends lines in call order to <folder>/<name> at mode 0600", async () => {
  const log = openRotatingLog({ folder, name: "service.log", maxBytes: 1024, keep: 2 });
  await Promise.all([1, 2, 3].map((n) => log.append(line(n))));
  await log.close();
  expect(log.path).toBe(join(folder, "service.log"));
  expect(await readFile(log.path, "utf8")).toBe(line(1) + line(2) + line(3));
  expect((await stat(log.path)).mode & 0o777).toBe(0o600);
});

test("rotates by size and keeps only the newest files", async () => {
  const size = Buffer.byteLength(line(1));
  const log = openRotatingLog({ folder, name: "service.log", maxBytes: size * 2, keep: 2 });
  for (let n = 1; n <= 7; n += 1) await log.append(line(n));
  await log.close();
  expect((await readdir(folder)).toSorted()).toEqual([
    "service.log",
    "service.log.1",
    "service.log.2",
  ]);
  expect(await readFile(join(folder, "service.log"), "utf8")).toBe(line(7));
  expect(await readFile(join(folder, "service.log.1"), "utf8")).toBe(line(5) + line(6));
  expect(await readFile(join(folder, "service.log.2"), "utf8")).toBe(line(3) + line(4));
});

test("counts what an earlier process already wrote before rotating", async () => {
  const size = Buffer.byteLength(line(1));
  const first = openRotatingLog({ folder, name: "service.log", maxBytes: size * 2, keep: 1 });
  await first.append(line(1));
  await first.append(line(2));
  await first.close();
  const second = openRotatingLog({ folder, name: "service.log", maxBytes: size * 2, keep: 1 });
  await second.append(line(3));
  await second.close();
  expect(await readFile(join(folder, "service.log"), "utf8")).toBe(line(3));
  expect(await readFile(join(folder, "service.log.1"), "utf8")).toBe(line(1) + line(2));
});

test("a line longer than the limit still lands in a file of its own", async () => {
  const log = openRotatingLog({ folder, name: "service.log", maxBytes: 8, keep: 1 });
  await log.append(line(1));
  await log.append(line(2));
  await log.close();
  expect(await readFile(join(folder, "service.log"), "utf8")).toBe(line(2));
  expect(await readFile(join(folder, "service.log.1"), "utf8")).toBe(line(1));
});
