import { browserOf } from "./e1-aggregate.ts";
import {
  frameSample,
  identityPair,
  install,
  pageSample,
  popupSample,
  routeC,
  workerSamples,
} from "./e7-loads.ts";
import type { Reach, Strategy } from "./e7-loads.ts";
import { evaluateSample } from "./e7-samples.ts";
import type { E7Sample } from "./e7-samples.ts";
import { capabilitiesOf, summarize, summarizeIdentity, unavailable } from "./e7-summary.ts";
import type { IdentitySample } from "./e7-summary.ts";
import { CONTROL, expect, prepareFixture, test, writeSamples } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { sized } from "./samples.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.6; docs/poc/namespace-sessions/experiments/E7.md reports them.
// Route C is a MAIN-world registered content script; the harness only drives pages and reads results.
const PAGE_ITERATIONS = sized(20);
const WORKER_ITERATIONS = sized(10);
const IDP_ITERATIONS = sized(5);
const IDENTITY_PAIRS = 3;
const PAGES = ["/", "/storage.html"];
const STRATEGIES: Strategy[] = ["fail-closed", "blob", "data"];
const TYPES = ["classic", "module"];
const REACHES: Reach[] = ["app-only", "with-idp"];
const FIXTURE = "the frozen fixture (apps/fixture/public) has";
const UNAVAILABLE: [string, string][] = [
  ["same-origin-iframe", `${FIXTURE} no same-origin iframe`],
  ["about-blank-child", `${FIXTURE} no about:blank or srcdoc child frame`],
  ["sandboxed-frame", `${FIXTURE} no sandboxed frame`],
];

type Samples = Record<string, E7Sample[]>;

function keep(samples: Samples, evidence: unknown[], ...kept: E7Sample[]): void {
  for (const sample of kept) {
    (samples[sample.hypothesis] ??= []).push(sample);
    evidence.push({ sample, outcome: evaluateSample(sample) });
  }
}

async function pageSamples(run: Run, samples: Samples, evidence: unknown[]) {
  await install(run.extension, "fail-closed");
  for (let iteration = 0; iteration < PAGE_ITERATIONS; iteration += 1) {
    for (const path of PAGES) keep(samples, evidence, await pageSample(run, path));
  }
}

/** Every worker strategy installed in turn, each with classic and module workers. */
async function workerRealms(run: Run, samples: Samples, evidence: unknown[]) {
  for (const strategy of STRATEGIES) {
    await install(run.extension, strategy);
    for (let iteration = 0; iteration < WORKER_ITERATIONS; iteration += 1) {
      for (const type of TYPES)
        keep(samples, evidence, ...(await workerSamples(run, strategy, type)));
    }
  }
}

/** The renew iframe and the login popup on the IdP, with Route C registered without and with it. */
async function idpRealms(run: Run, samples: Samples, evidence: unknown[]) {
  for (const reach of REACHES) {
    await install(run.extension, "fail-closed", reach);
    for (let iteration = 0; iteration < IDP_ITERATIONS; iteration += 1) {
      keep(samples, evidence, await frameSample(run, reach));
      keep(samples, evidence, await popupSample(run, reach));
    }
  }
}

/** Shared-worker identity: native constructors first, then each wrapper that starts a worker. */
async function identityPairs(run: Run, evidence: unknown[]): Promise<IdentitySample[]> {
  const pairs: IdentitySample[] = [];
  for (const variant of ["control-native", "blob", "data"] as const) {
    if (variant === "control-native") await routeC(run.extension, "uninstall()");
    else await install(run.extension, variant);
    for (let pair = 0; pair < IDENTITY_PAIRS; pair += 1) {
      const sample = await identityPair(run, variant);
      pairs.push(sample);
      evidence.push({ identity: sample });
    }
  }
  return pairs;
}

test.describe("E7: Route C reaches pages and the workers they start, before their first statement", () => {
  test.describe.configure({ timeout: 1_800_000 });

  test("every realm runs its iterations and gets a verdict", async ({ extension, observer }) => {
    await prepareFixture(extension);
    const run: Run = { extension, context: observer.page.context() };
    const samples: Samples = {};
    const evidence: unknown[] = [];
    await pageSamples(run, samples, evidence);
    const registration = await routeC(extension, "registered()");
    await workerRealms(run, samples, evidence);
    await idpRealms(run, samples, evidence);
    const pairs = await identityPairs(run, evidence);
    await routeC(extension, "uninstall()");
    await observer.collectLedger(CONTROL);
    await writeSamples(observer.directory, evidence);

    const browser = browserOf(extension);
    const realms = ["page", "cross-site-iframe", "popup", "dedicated-worker", "shared-worker"];
    const verdicts = [
      ...realms.map((realm) => summarize(realm, samples[realm] ?? [], browser)),
      summarizeIdentity(pairs, browser),
      ...UNAVAILABLE.map(([realm, reason]) => unavailable(realm, reason, browser)),
    ];
    for (const verdict of verdicts) await appendVerdict(verdict);
    await mergeCapabilities(capabilitiesOf(verdicts, registration));
    console.log(JSON.stringify(verdicts, null, 2));

    const workerLoads = STRATEGIES.length * WORKER_ITERATIONS * TYPES.length;
    expect(verdicts.map(({ hypothesis, samples: count }) => [hypothesis, count])).toEqual([
      ["page", PAGE_ITERATIONS * PAGES.length],
      ["cross-site-iframe", IDP_ITERATIONS * REACHES.length],
      ["popup", IDP_ITERATIONS * REACHES.length],
      ["dedicated-worker", workerLoads],
      ["shared-worker", workerLoads],
      ["shared-worker-identity", IDENTITY_PAIRS * 3],
      ...UNAVAILABLE.map(([realm]) => [realm, 0]),
    ]);
    for (const verdict of verdicts.slice(0, 5)) {
      expect(typeof verdict.counts?.failClosed, verdict.hypothesis).toBe("number");
      if (verdict.verdict === "pass") expect(verdict.counts?.passed).toBe(verdict.samples);
    }
  });
});
