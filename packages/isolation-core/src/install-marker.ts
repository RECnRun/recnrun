import * as v from "valibot";
import { BootstrapOptionsSchema } from "./marker.ts";
import { patchCaches, patchFetch, patchIndexedDb } from "./marker-patches.ts";

/** The property a patched scope exposes so a debugger can tell which marker it carries. */
export const DIAGNOSTICS_KEY = "__recnrun";

const PATCHERS = { fetch: patchFetch, indexedDB: patchIndexedDb, caches: patchCaches } as const;

/** The global each patch replaces or wraps. */
export type PatchName = keyof typeof PATCHERS;

/** `skipped`: the global was missing; `already-installed`: an earlier call patched it. */
export type PatchStatus = "installed" | "already-installed" | "skipped";

export interface PatchReport {
  readonly status: PatchStatus;
  /** `typeof` the global when the answer was made. */
  readonly typeof: string;
}

export interface MarkerDiagnostics {
  readonly marker: string;
  readonly installedAt: number;
  readonly patches: Readonly<Record<PatchName, PatchReport>>;
  /** The scope's `performance.now()` at install: how long the realm had run before the patches. */
  readonly realmAgeMs?: number;
}

const PatchSchema = v.object({
  status: v.picklist(["installed", "already-installed", "skipped"]),
  typeof: v.string(),
});

export const MarkerDiagnosticsSchema = v.object({
  marker: v.string(),
  installedAt: v.number(),
  patches: v.object({ fetch: PatchSchema, indexedDB: PatchSchema, caches: PatchSchema }),
  realmAgeMs: v.optional(v.number()),
});

const NAMES = Object.keys(PATCHERS) as PatchName[];

function patchesOf(report: (name: PatchName) => PatchReport): MarkerDiagnostics["patches"] {
  const entries = NAMES.map((name) => [name, Object.freeze(report(name))] as const);
  return Object.freeze(Object.fromEntries(entries) as Record<PatchName, PatchReport>);
}

function realmAgeOf(scope: object): { realmAgeMs?: number } {
  const clock: unknown = Reflect.get(scope, "performance");
  const now: unknown = typeof clock === "object" && clock ? Reflect.get(clock, "now") : undefined;
  if (typeof now !== "function") return {};
  return { realmAgeMs: Number(Reflect.apply(now, clock, [])) };
}

/** A re-run patches nothing, so a patch skipped at install stays skipped. */
function again(scope: object, existing: MarkerDiagnostics): MarkerDiagnostics {
  const patches = patchesOf((name) => ({
    status: existing.patches[name].status === "skipped" ? "skipped" : "already-installed",
    typeof: typeof Reflect.get(scope, name),
  }));
  return { ...existing, patches };
}

/**
 * Patches `fetch`, `indexedDB`, and `caches` of `scope` so every request, database, and cache it
 * makes carries `options.marker`, and answers what it patched. A second call changes nothing.
 */
export function installMarker(scope: object, options: unknown): MarkerDiagnostics {
  const existing: unknown = Reflect.get(scope, DIAGNOSTICS_KEY);
  if (v.is(MarkerDiagnosticsSchema, existing)) return again(scope, existing);
  const { marker } = v.parse(BootstrapOptionsSchema, options);
  const realmAge = realmAgeOf(scope);
  const patches = patchesOf((name) => {
    const seen = typeof Reflect.get(scope, name);
    return { status: PATCHERS[name](scope, marker) ? "installed" : "skipped", typeof: seen };
  });
  const diagnostics = Object.freeze({ marker, installedAt: Date.now(), patches, ...realmAge });
  // Read-only and non-enumerable: page code cannot overwrite it, and it stays out of key listings.
  Object.defineProperty(scope, DIAGNOSTICS_KEY, { value: diagnostics });
  return diagnostics;
}
