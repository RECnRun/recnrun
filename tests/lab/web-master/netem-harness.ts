import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { call } from "./lifecycle-harness.ts";
import { treeUsage } from "./proc-usage.ts";
import { NAME } from "./trust-harness.ts";
import { visual } from "./visual-harness.ts";

/*
 * W6.E network faults: `tc netem` on UDP only (WebRTC's transport), so the harness's CDP and HTTP
 * over TCP keep working. Applied inside the lab container, which runs with NET_ADMIN.
 */

const run = promisify(execFile);
const tc = (...args: string[]) => run("tc", args);
const SAMPLE_MS = 500;
const PING_CAP_MS = 2_000;

/** Sends every UDP packet on `dev` through one netem qdisc with `netem` parameters. */
export async function impairUdp(dev: string, netem: string[]): Promise<void> {
  await tc("qdisc", "add", "dev", dev, "root", "handle", "1:", "prio");
  await tc("qdisc", "add", "dev", dev, "parent", "1:3", "handle", "30:", "netem", ...netem);
  const match = (protocol: string, family: string, prio: string) =>
    tc(
      "filter",
      "add",
      "dev",
      dev,
      "parent",
      "1:0",
      "protocol",
      protocol,
      "prio",
      prio,
      "u32",
      "match",
      family,
      "protocol",
      "17",
      "0xff",
      "flowid",
      "1:3",
    );
  await match("ip", "ip", "1");
  await match("ipv6", "ip6", "2");
}

export const restore = (dev: string) =>
  tc("qdisc", "del", "dev", dev, "root").then(
    () => true,
    () => false,
  );

/** One control round trip on recnrun-lab, or null when none came back within `ms`. */
export async function pingWithin(page: Page, ms = PING_CAP_MS): Promise<number | null> {
  const started = performance.now();
  const pong = call<number>(page, "ping", NAME, 1).then(() => performance.now() - started);
  return Promise.race([pong, delay(ms).then(() => null)]);
}

interface Transport {
  sent: number;
  buffered: number;
  maxBuffered: number;
  drops: Record<string, number>;
}

export interface Sample {
  t: number;
  buffered: number;
  maxBuffered: number;
  sent: number;
  senderDrops: Record<string, number>;
  shown: number;
  masterDrops: Record<string, number>;
  rssMiB: number;
  cpuSeconds: number;
  pingMs: number | null;
  statusMs: number | null;
}

async function statusWithin(page: Page, jobId: string): Promise<number | null> {
  const started = performance.now();
  const reply = call(page, "jobStatus", NAME, [jobId]).then(() => performance.now() - started);
  return Promise.race([reply, delay(PING_CAP_MS).then(() => null)]);
}

/** Samples sender buffer, drops, master frames, worker cost, and control latency for `ms`. */
export async function sampleFor(
  page: Page,
  worker: LoadedExtension,
  jobId: string,
  ms: number,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const started = performance.now();
  while (performance.now() - started < ms) {
    const sender = await visual<Transport>(worker, "transport");
    const shown = await call<{ frames: number; drops: Record<string, number> }>(
      page,
      "visualStats",
    );
    const usage = await treeUsage(worker.chrome.pid);
    samples.push({
      t: Math.round(performance.now() - started),
      buffered: sender.buffered,
      maxBuffered: sender.maxBuffered,
      sent: sender.sent,
      senderDrops: sender.drops,
      shown: shown.frames,
      masterDrops: shown.drops,
      rssMiB: usage.rssMiB,
      cpuSeconds: usage.cpuSeconds,
      pingMs: await pingWithin(page),
      statusMs: await statusWithin(page, jobId),
    });
    await delay(SAMPLE_MS);
  }
  return samples;
}

/** Busy-waits the master page's main thread `busyMs` of every 100 ms for `ms`: a slow receiver. */
export const slowReceiver = (page: Page, ms: number, busyMs = 90) =>
  page.evaluate(
    ([total, busy]) => {
      const end = performance.now() + total;
      const tick = () => {
        const until = performance.now() + busy;
        while (performance.now() < until);
        if (performance.now() < end) setTimeout(tick, 100 - busy);
      };
      setTimeout(tick, 0);
    },
    [ms, busyMs] as const,
  );
