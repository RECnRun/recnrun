// Measurements of the capture benchmark: the page's own view, Chrome's processes, and Node's.
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Runs in every document before its scripts: input-to-handler delays and dispatch counts. */
function pageProbe() {
  const bench = { click: [], key: [], clickAt: [], inputs: 0 };
  // Window listeners in the bubble phase run after the page's own handler of the event.
  addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    bench.click.push(performance.now() - event.timeStamp);
    bench.clickAt.push(Date.now());
  });
  addEventListener("keydown", (event) => {
    if (event.isTrusted) bench.key.push(performance.now() - event.timeStamp);
  });
  addEventListener("input", () => (bench.inputs += 1));
  Object.defineProperty(window, "__bench", { value: bench });
}

export const PAGE_PROBE = `(${pageProbe.toString()})()`;

/** What the page saw since it loaded. */
export function readPage(page) {
  return page.evaluate(() => {
    const { click, key, clickAt, inputs } = window.__bench;
    return { click, key, clickAt, inputs };
  });
}

const metric = (metrics, name) => metrics.find((entry) => entry.name === name)?.value ?? null;

async function processCpu(session) {
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    return processInfo;
  } catch {
    return null;
  }
}

async function rssOf(ids) {
  if (process.platform !== "linux") return null;
  let total = 0;
  for (const id of ids) {
    const status = await readFile(`/proc/${id}/status`, "utf8").catch(() => "");
    total += Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) * 1024;
  }
  return total;
}

const cpuTotal = (processes) => processes.reduce((sum, { cpuTime }) => sum + cpuTime, 0);

/** Chrome's CPU time over the window (every process), its resident memory, and the renderer's metrics. */
export async function startChromeProbe(browser, page) {
  const browserSession = await browser.newBrowserCDPSession();
  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send("Performance.enable");
  const before = await processCpu(browserSession);
  const metricsBefore = (await pageSession.send("Performance.getMetrics")).metrics;
  return async () => {
    const after = await processCpu(browserSession);
    const { metrics } = await pageSession.send("Performance.getMetrics");
    const task = metric(metrics, "TaskDuration");
    const taskBefore = metric(metricsBefore, "TaskDuration");
    return {
      cpuSeconds: before && after ? round(cpuTotal(after) - cpuTotal(before), 3) : null,
      rssBytes: after ? await rssOf(after.map(({ id }) => id)) : null,
      jsHeapUsedBytes: metric(metrics, "JSHeapUsedSize"),
      rendererTaskSeconds:
        task === null || taskBefore === null ? null : round(task - taskBefore, 3),
    };
  };
}

export const round = (value, digits = 1) => Number(value.toFixed(digits));

/** This process's CPU over the window and its memory at the end. */
export function startNodeProbe() {
  const cpu = process.cpuUsage();
  const startedAt = performance.now();
  return () => {
    const { user, system } = process.cpuUsage(cpu);
    const { rss, heapUsed } = process.memoryUsage();
    const elapsedMs = performance.now() - startedAt;
    return {
      cpuUserMs: round(user / 1000),
      cpuSystemMs: round(system / 1000),
      cpuPercent: round(((user + system) / 1000 / elapsedMs) * 100),
      rssBytes: rss,
      heapUsedBytes: heapUsed,
    };
  };
}

/** Bytes under a file or folder; 0 when it does not exist. */
export async function sizeOf(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const names = await readdir(path);
  const sizes = await Promise.all(names.map((name) => sizeOf(join(path, name))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** Starts the fixture application as a child on free loopback ports, so its CPU is not counted here. */
export function startFixture(root) {
  const child = spawn(process.execPath, [join(root, "apps/fixture/src/bin.ts")], {
    env: { ...process.env, RECNRUN_FIXTURE_PORT: "0", RECNRUN_FIXTURE_SECOND_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = () => {
    child.kill("SIGTERM");
  };
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("exit", (code) => reject(new Error(`The fixture exited (${code}): ${output}`)));
    child.stdout.on("data", (data) => {
      output += String(data);
      const origin = /fixture on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (origin) resolve({ origin, stop });
    });
  });
}

/** Chrome, Node, and the test image when the benchmark runs in the test container. */
export async function versionsOf(chrome) {
  const container = await readFile("/opt/recnrun/versions.json", "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  return {
    chrome,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    imageId: process.env.RECNRUN_IMAGE_ID ?? null,
    container,
  };
}
