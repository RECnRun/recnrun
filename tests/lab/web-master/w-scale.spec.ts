import { rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended, ledger, settle } from "./admission-harness.ts";
import { call, jobOps, link, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { masterStats, observeStart, pageSigner } from "./observe-harness.ts";
import { quantiles } from "./proc-usage.ts";
import { measure, measureDetached } from "./scale-harness.ts";
import type { Window } from "./scale-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { fields, provision } from "./trust-harness.ts";
import { op, writeEvidence } from "./visual-harness.ts";

/*
 * W6.E scale and cost (W6-PLAN.md slice E), behind RECNRUN_W6_BENCH=1: 1 and 3 workers (headed,
 * headless, headed), the master tab visible and hidden behind another tab, each against a run of
 * the same jobs with no stream.
 */

test.skip(process.env.RECNRUN_W6_BENCH !== "1", "W6.E bench cells run with RECNRUN_W6_BENCH=1");
test.describe.configure({ mode: "serial" });

const HOLD_MS = 10_000;
const WINDOW_MS = 6_000;

interface Member {
  name: string;
  root: string;
  worker: LoadedExtension;
  headless: boolean;
}

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  page: Page;
  cover: Page;
  members: Member[];
  hidden: boolean;
  visibility: string[];
  results: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.E scale setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  const cover = await context.newPage();
  const { publicKey } = await pageSigner(page);
  const members: Member[] = [];
  for (const index of [0, 1, 2]) {
    const { root, id } = await provisionWorker();
    const headless = index === 1;
    const worker = await startWorker(root, id, headless);
    await provision(worker, { masterKey: publicKey, allowlist: [target.origin] });
    const name = `w${index}`;
    expect(await link(page, worker, name)).toBe(true);
    members.push({ name, root, worker, headless });
  }
  shared = {
    site,
    target,
    master,
    page,
    cover,
    members,
    hidden: false,
    visibility: [],
    results: {},
  };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence("w6-scale.json", { chrome: c.master.version, ...c.results });
  for (const { worker, root } of c.members) {
    await worker.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  await c.master.close();
  await c.target.close();
  await c.site.close();
});

/** Submits one held job on the blue late page plus the form POST; answers its id and ops. */
async function submit(c: Cell, member: Member) {
  const origin = c.target.origin;
  const base = fields(origin);
  const ops = [
    op("navigate", { url: `${origin}/visual/late?ms=${HOLD_MS}` }),
    op("wait", { selector: "#late", state: "attached" }, HOLD_MS + 5_000),
    ...jobOps(origin, base.jobId),
  ];
  const job = { jobId: base.jobId, origins: [origin], ops };
  const submittedAt = performance.now();
  // Over the link, as the site submits: the worker's service worker may be asleep.
  const reply = await call<{ status: string }>(c.page, "submit", member.name, job);
  expect(reply).toMatchObject({ status: "ACCEPTED" });
  return { jobId: base.jobId, ops, submittedAt };
}

type Job = Awaited<ReturnType<typeof submit>>;

/** Starts LIVE on each link; answers the start round trip and the master's first-frame time. */
async function observeAll(c: Cell, members: Member[], jobs: Job[]) {
  const startMs: number[] = [];
  for (const [index, member] of members.entries()) {
    const started = performance.now();
    const reply = await observeStart(c.page, jobs[index]?.jobId ?? "", "live", member);
    expect(reply).toMatchObject({ ok: true });
    startMs.push(performance.now() - started);
  }
  type Session = { jobId: string; firstFrameMs: number | null };
  const firsts = () =>
    masterStats(c.page).then((stats) =>
      jobs.map((job) => {
        const sessions = stats.sessions as unknown as Session[];
        return sessions.find((session) => session.jobId === job.jobId)?.firstFrameMs ?? null;
      }),
    );
  const firstMs = await until(firsts, (all) => all.every((ms) => ms !== null), 15_000);
  // Request to first frame: the start round trip plus the master's accepted-to-shown time.
  return startMs.map((ms, index) => Math.round(ms + (firstMs[index] ?? 0)));
}

/** A measured window; a hidden master tab is measured with Playwright detached. */
async function windowFor(c: Cell, members: Member[]): Promise<Window> {
  const workers = members.map((member) => member.worker);
  if (!c.hidden) return measure(c.page, c.master, workers, WINDOW_MS);
  const detached = await measureDetached(c.page, c.master, workers, WINDOW_MS);
  const pages = detached.browser.contexts().flatMap((context) => context.pages());
  c.page = detached.page;
  c.cover = pages.find((page) => page.url() === "about:blank") ?? c.cover;
  c.visibility.push(...detached.visibility);
  return detached.window;
}

/** One phase: the same jobs on every member, observed LIVE or not; answers cost and timing. */
async function phase(c: Cell, members: Member[], observe: boolean) {
  const jobs: Job[] = [];
  for (const member of members) jobs.push(await submit(c, member));
  const opened = (member: Member, job: Job) => () =>
    until(
      () => ledger(member.worker, job.jobId),
      (record) => record?.ops[0]?.state === "DONE",
      15_000,
    );
  for (const [index, member] of members.entries()) await opened(member, jobs[index] as Job)();
  const firstFrameMs = observe ? await observeAll(c, members, jobs) : [];
  const window = await windowFor(c, members);
  const durations = await Promise.all(
    members.map(async (member, index) => {
      const job = jobs[index] as Job;
      const record = await ended(member.worker, job.jobId);
      expect(record.ops.map((entry) => entry.state)).toEqual(job.ops.map(() => "DONE"));
      expect(c.target.count(job.jobId)).toBe(1);
      return Math.round(performance.now() - job.submittedAt);
    }),
  );
  if (observe) for (const member of members) await call(c.page, "observeStop", member.name);
  for (const member of members) await settle(member.worker);
  return { firstFrameMs, window, jobMs: durations };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

for (const workers of [1, 3]) {
  for (const masterTab of ["visible", "hidden"] as const) {
    test(`W6.E ${workers} worker(s), master tab ${masterTab}: cost against no stream`, async () => {
      const c = cell();
      const members = c.members.slice(0, workers);
      // Hidden: another tab of the same master window in front; no Emulation override, no PWA.
      c.hidden = masterTab === "hidden";
      c.visibility = [];
      await (c.hidden ? c.cover : c.page).bringToFront();
      const control = await phase(c, members, false);
      const stream = await phase(c, members, true);
      const latency = stream.window.captureToDisplayMs;
      // Screencast stamps come from the compositor's clock: a few ms of skew can make one negative.
      if (latency.n > 0) expect(Number.isFinite(latency.p50)).toBe(true);
      if (c.hidden) {
        expect(c.visibility.length).toBeGreaterThan(0);
        expect(new Set(c.visibility)).toEqual(new Set(["hidden"]));
      } else expect(latency.n).toBeGreaterThan(0);
      c.results[`${workers}-${masterTab}`] = {
        workers: members.map((member) => (member.headless ? "headless" : "headed")),
        masterTab,
        visibilityDuringWindows: c.hidden ? [...new Set(c.visibility)] : ["visible"],
        requestToFirstFrameMs: { ...quantiles(stream.firstFrameMs), all: stream.firstFrameMs },
        control: control.window,
        stream: stream.window,
        jobMs: { control: control.jobMs, stream: stream.jobMs },
        jobDeltaMs: Math.round(mean(stream.jobMs) - mean(control.jobMs)),
      };
    });
  }
}
