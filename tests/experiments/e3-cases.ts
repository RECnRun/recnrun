import { evaluateSample } from "./e3-samples.ts";
import type { E3Sample } from "./e3-samples.ts";
import {
  CONDITION,
  clearApp,
  load,
  markerFor,
  namesOf,
  sampleOf,
  stopServiceWorkers,
  swEffect,
  workerEffect,
} from "./e3-loads.ts";
import type { CloseReport, Loaded } from "./e3-loads.ts";
import { APP, SERVICE_WORKERS } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { sized } from "./samples.ts";

// The loops of E3's hypotheses that load pages: a new registration per load, or a cold restart.
/** Loads per service-worker variant, and per dedicated-worker type, in each hypothesis. */
export const SW_LOADS = sized(20);
export const DEDICATED_LOADS = sized(10);
export const COLD_LOADS = sized(20);
export const DEDICATED_TYPES = ["classic", "module"] as const;
const COLD_MODES = ["pause", "watch"] as const;

/** One sample's evidence: what was evaluated, the outcome, and what the load saw around it. */
export function evidenceOf(sample: E3Sample, loaded: Loaded, extra: object = {}) {
  const { seen, report, painted } = loaded;
  return { sample, outcome: evaluateSample(sample), seen, report, painted, ...extra };
}

/**
 * Every service-worker variant and both dedicated-worker types, each a new registration in a new
 * tab, attached as `attach` says. A warm run keeps the origin between loads.
 */
export async function freshSamples(
  run: Run,
  hypothesis: string,
  attach: "pause" | "watch",
  evidence: unknown[],
): Promise<E3Sample[]> {
  const samples: E3Sample[] = [];
  const clear = CONDITION !== "warm";
  let preexisting: string[] = [];
  const add = (loaded: Loaded, sample: E3Sample) => {
    samples.push(sample);
    evidence.push(evidenceOf(sample, loaded));
    preexisting = clear ? [] : namesOf(loaded.inventory);
  };
  for (let iteration = 0; iteration < SW_LOADS; iteration += 1) {
    for (const [variant, script] of Object.entries(SERVICE_WORKERS)) {
      const marker = markerFor(`${attach}-sw-${variant}`, iteration);
      const url = `${APP}/sw.html?sw=${variant}`;
      const loaded = await load(run, { url, name: "sw", marker, attach, clear });
      const base = { hypothesis, variant: `sw-${variant}`, mode: attach, marker, script };
      add(
        loaded,
        sampleOf(loaded, { ...base, store: "fixture-sw", preexisting }, swEffect(script)),
      );
    }
  }
  for (let iteration = 0; iteration < DEDICATED_LOADS; iteration += 1) {
    for (const type of DEDICATED_TYPES) {
      const marker = markerFor(`${attach}-dedicated-${type}`, iteration);
      const url = `${APP}/workers.html?type=${type}`;
      const loaded = await load(run, { url, name: "workers", marker, attach, clear });
      const script = `/worker.js?type=${type}`;
      const base = { hypothesis, variant: `dedicated-${type}`, mode: attach, marker, script };
      const store = "fixture-dedicated";
      add(loaded, sampleOf(loaded, { ...base, store, preexisting }, workerEffect(script)));
    }
  }
  if (!clear) await clearApp(run, markerFor(`${attach}-clear`, 0));
  return samples;
}

/**
 * Registers each variant in an unattached load, then, per sample, stops its worker through the
 * isolator and loads the page again in a new tab, attached as the mode says: the navigation
 * restarts the worker.
 */
export async function coldSamples(run: Run, evidence: unknown[]) {
  const samples: E3Sample[] = [];
  const closes: CloseReport[] = [];
  for (const mode of COLD_MODES) {
    for (const [variant, script] of Object.entries(SERVICE_WORKERS)) {
      const url = `${APP}/sw.html?sw=${variant}`;
      const first = markerFor(`cold-register-${variant}`, 0);
      const registered = await load(run, {
        url,
        name: "sw",
        marker: first,
        attach: "none",
        clear: false,
      });
      let preexisting = namesOf(registered.inventory);
      for (let iteration = 0; iteration < COLD_LOADS; iteration += 1) {
        const stop = await stopServiceWorkers(run);
        closes.push(...stop.closes);
        const marker = markerFor(`cold-${mode}-${variant}`, iteration);
        const clear = iteration === COLD_LOADS - 1;
        const loaded = await load(run, { url, name: "sw", marker, attach: mode, clear });
        const base = { hypothesis: "cold-start-navigation", variant: mode, mode, marker, script };
        const { stopped, stopMs } = stop;
        const cold = { ...base, store: "fixture-sw", preexisting, stopped, stopMs };
        const sample = sampleOf(loaded, cold, swEffect(script));
        samples.push(sample);
        evidence.push(evidenceOf(sample, loaded, { closes: stop.closes, serviceWorker: variant }));
        preexisting = namesOf(loaded.inventory);
      }
    }
  }
  return { samples, closes };
}
