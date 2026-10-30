import type { BrowserContext, Worker } from "@playwright/test";
import { appLog, appState, requestsOf } from "./fixtures/app.ts";
import type { AppLogEntry } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  barrierLeft,
  identityFor,
  incognitoWindows,
  normalCookies,
  restoredReads,
  setNormalCookie,
  startWithIdentity,
} from "./fixtures/identity.ts";
import type { StepTiming } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { spread } from "./fixtures/teardown-probe.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Starts per restore delay in one test; the recorded run sets `POC_REPEATS=50`. */
const CYCLES = Number(process.env.POC_REPEATS ?? "3");

const STEPS = [
  "store-gone",
  "window",
  "cookie-store",
  "cookies",
  "origins",
  "barrier",
  "navigate",
  "restore",
  "unbarrier",
  "reload",
  "layout",
];

const isFirstReport = ({ kind, body }: AppLogEntry) =>
  kind === "report" && (body as { phase?: string }).phase === "first";

/** What reached the server before the release: everything before the reload's `/app/` request. */
function beforeRelease(entries: readonly AppLogEntry[]): AppLogEntry[] {
  const documents = entries.flatMap(({ kind, path }, index) =>
    kind === "request" && path === "/app/" ? [index] : [],
  );
  return entries.slice(0, documents[1] ?? entries.length);
}

interface Cycle {
  context: BrowserContext;
  serviceWorker: Worker;
  run: string;
  delay: number;
}

/** One start under the site's own CSP; proves what the app saw first and what the barrier let by. */
async function proveCycle({ context, serviceWorker, run, delay }: Cycle) {
  const query = `run=${run}&csp=1`;
  const target = `${APP}/app/redirect?${query}`;
  const timings = await startWithIdentity(serviceWorker, target, identityFor(run), delay);
  expect(timings.map(({ step }) => step)).toEqual(STEPS);
  const page = await pageAt(context, `${APP}/app/?${query}`);

  const state = await appState(page);
  expect(state.failure, run).toBeUndefined();
  expect(state.first, run).toMatchObject(restoredReads(run));
  expect(state).toMatchObject({ module: true, worker: "ready", frame: true, image: true });
  // The site's own policy still holds once the barrier's is gone.
  expect(state.unnonced).toBe(false);
  expect(state.violations.map(({ directive }) => directive)).toContain("script-src-elem");

  const entries = await appLog(run);
  const held = beforeRelease(entries);
  expect(requestsOf(held), run).toEqual(["/app/redirect document", "/app/ document"]);
  expect(
    held.filter(({ kind }) => kind === "report"),
    run,
  ).toEqual([]);
  // The cookies were in the tab's store before its first request, and only they.
  for (const request of held) expect(request.cookies, run).toEqual(["run", "theme"]);
  expect(entries.find(isFirstReport)?.body, run).toMatchObject(restoredReads(run));
  expect(await barrierLeft(serviceWorker)).toEqual({ rules: 0, scripts: 0 });
  return { page, timings };
}

for (const delay of [0, 2_000]) {
  test(`the app's first reads see the restored identity, with the restore held ${delay} ms`, async ({
    context,
    serviceWorker,
  }) => {
    test.setTimeout(30_000 + CYCLES * (delay + 10_000));
    await setNormalCookie(serviceWorker, `${APP}/`);
    const normal = await normalCookies(serviceWorker, `${APP}/`);
    const cycles: StepTiming[][] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      const run = `barrier-${delay}-${cycle}-${Date.now()}`;
      const { page, timings } = await proveCycle({ context, serviceWorker, run, delay });
      cycles.push(timings);
      // Closed as a user would; the next start must wait for Chrome to drop the Incognito data.
      await page.close();
      await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
    }
    expect(await normalCookies(serviceWorker, `${APP}/`)).toEqual(normal);
    const stats = Object.fromEntries(
      STEPS.map((step) => [
        step,
        spread(cycles.map((each) => each.find((t) => t.step === step)?.ms)),
      ]),
    );
    await keep(`barrier-${delay}ms`, { delay, cycles: cycles.length, stats, perCycle: cycles });
  });
}

test("a redirect off the target origin commits script-free on the target, and the release follows it", async ({
  context,
  serviceWorker,
}) => {
  const run = `barrier-off-${Date.now()}`;
  const query = `to=other&run=${run}`;
  const timings = await startWithIdentity(
    serviceWorker,
    `${APP}/app/redirect?${query}`,
    identityFor(run),
  );
  expect(timings.map(({ step }) => step)).toEqual(STEPS);
  await pageAt(context, `http://other.localhost:5192/app/?${query}`);
  expect(await incognitoWindows(serviceWorker)).toBe(1);
  expect(await barrierLeft(serviceWorker)).toEqual({ rules: 0, scripts: 0 });
  const entries = await appLog(run);
  // The barrier's request lost its Location; the release reload repeats it and follows it.
  const released = entries.findLastIndex(({ path }) => path === "/app/redirect");
  const held = entries.slice(0, released);
  expect(requestsOf(held)).toEqual(["/app/redirect document"]);
  expect(held.some(({ kind }) => kind === "report")).toBe(false);
  expect(requestsOf(entries.slice(released)).slice(0, 2)).toEqual([
    "/app/redirect document",
    "/app/ document",
  ]);
});
