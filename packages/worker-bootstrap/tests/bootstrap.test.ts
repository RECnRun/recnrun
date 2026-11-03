import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, test } from "vite-plus/test";
import { renderArtifact, renderModule } from "../src/artifact.ts";
import {
  BOOTSTRAP_HASH,
  BOOTSTRAP_SOURCE,
  BOOTSTRAP_VERSION,
  withMarker,
  withOriginal,
} from "../src/index.ts";

const SCRIPT = "http://app.localhost:4600/sw-main.js?variant=classic";
const ME = "http://api.localhost:4601/me?from=%2Fsw-main.js%3Fvariant%3Dclassic";

/** A worker-like global in its own realm: only JavaScript builtins plus these fakes. */
function workerRealm(stores: string[] = []) {
  const effects: string[] = [];
  const sandbox: Record<string, unknown> = {
    URL,
    Request,
    DOMException,
    location: { href: SCRIPT },
    fetch(input: unknown) {
      effects.push(`fetch ${input instanceof Request ? input.url : String(input)}`);
      return Promise.resolve(undefined);
    },
    indexedDB: {
      open: (name: string) => effects.push(`indexedDB.open ${name}`),
      deleteDatabase: (name: string) => effects.push(`indexedDB.deleteDatabase ${name}`),
      databases: () => Promise.resolve(stores.map((name) => ({ name }))),
    },
    caches: {
      open: (name: string) => effects.push(`caches.open ${name}`),
      has: () => Promise.resolve(false),
      delete: () => Promise.resolve(false),
      keys: () => Promise.resolve(stores),
      match: () => Promise.resolve(undefined),
    },
  };
  return { sandbox, context: vm.createContext(sandbox), effects };
}

// The fixture service worker's first statements (apps/fixture/public/sw-main.js).
const FIRST_STATEMENTS = `
  fetch(${JSON.stringify(ME)}, { credentials: "include" });
  indexedDB.open("fixture-sw");
  caches.open("fixture-sw");
`;

function diagnostics(value: unknown): { marker: unknown; installedAt: unknown } {
  const read = (key: string): unknown => Reflect.get(value as object, key);
  return { marker: read("marker"), installedAt: read("installedAt") };
}

describe("BOOTSTRAP_SOURCE", () => {
  test("is identified by its SHA-256 and the package version", () => {
    const hash = createHash("sha256").update(BOOTSTRAP_SOURCE).digest("hex");
    expect(BOOTSTRAP_HASH).toBe(hash);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(BOOTSTRAP_VERSION).toBe(manifest.version);
  });

  test("is one classic script that patches the realm's first fetch, database, and cache", () => {
    const { sandbox, context, effects } = workerRealm();
    const keys = Object.keys(sandbox);
    const installed = new vm.Script(withMarker("e2-m1")).runInContext(context);
    expect(diagnostics(installed).marker).toBe("e2-m1");
    vm.runInContext(FIRST_STATEMENTS, context);
    expect(effects).toEqual([
      `fetch ${ME}&__rec=e2-m1`,
      "indexedDB.open __rec:e2-m1:fixture-sw",
      "caches.open __rec:e2-m1:fixture-sw",
    ]);
    expect(Object.keys(sandbox), "the bundle leaks no global").toEqual(keys);
    expect(diagnostics(vm.runInContext("globalThis.__recnrun", context))).toEqual(
      diagnostics(installed),
    );
  });

  test("changes nothing when evaluated again in the same realm", () => {
    const { context, effects } = workerRealm();
    const first = diagnostics(vm.runInContext(withMarker("e2-m1"), context));
    const second = diagnostics(vm.runInContext(withMarker("e2-m2"), context));
    expect(second).toEqual(first);
    vm.runInContext(`fetch(${JSON.stringify(ME)})`, context);
    expect(effects).toEqual([`fetch ${ME}&__rec=e2-m1`]);
  });

  test("in original mode leaves the first effects unmarked and hides and refuses reserved names", async () => {
    const { sandbox, context, effects } = workerRealm(["__rec:e2-m1:fixture-sw", "fixture-sw"]);
    const keys = Object.keys(sandbox);
    const installed = diagnostics(vm.runInContext(withOriginal(), context));
    expect(installed.marker).toBeUndefined();
    expect(Reflect.get(vm.runInContext("globalThis.__recnrun", context), "original")).toBe(true);
    vm.runInContext(FIRST_STATEMENTS, context);
    expect(effects).toEqual([`fetch ${ME}`, "indexedDB.open fixture-sw", "caches.open fixture-sw"]);
    const listed: unknown = await vm.runInContext(
      "Promise.all([indexedDB.databases(), caches.keys()])",
      context,
    );
    expect(JSON.stringify(listed)).toBe('[[{"name":"fixture-sw"}],["fixture-sw"]]');
    const refused: unknown = vm.runInContext(
      'try { indexedDB.open("__rec:x"); "opened" } catch (error) { error.name + ": " + error.message }',
      context,
    );
    expect(refused).toBe(
      'SecurityError: RECnRun refused indexedDB.open("__rec:x"): names that start with "__rec:" are reserved',
    );
    expect(effects).toHaveLength(3);
    expect(Object.keys(sandbox), "the bundle leaks no global").toEqual(keys);
  });

  test("a realm in either mode ignores a later bootstrap of the other mode", () => {
    const { context, effects } = workerRealm();
    const original = diagnostics(vm.runInContext(withOriginal(), context));
    expect(diagnostics(vm.runInContext(withMarker("e2-m1"), context))).toEqual(original);
    vm.runInContext('indexedDB.open("fixture-sw")', context);
    expect(effects).toEqual(["indexedDB.open fixture-sw"]);
  });

  test("answers per patch what it installed and what it skipped, as a debugger reads it by value", () => {
    const { sandbox, context } = workerRealm();
    delete sandbox.caches;
    const byValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    const answer = byValue(vm.runInContext(withMarker("e2-m1"), context));
    expect(answer).toMatchObject({
      marker: "e2-m1",
      patches: {
        fetch: { status: "installed", typeof: "function" },
        indexedDB: { status: "installed", typeof: "object" },
        caches: { status: "skipped", typeof: "undefined" },
      },
    });
    const again = byValue(vm.runInContext(withMarker("e2-m1"), context));
    expect(again).toMatchObject({ patches: { fetch: { status: "already-installed" } } });
  });

  test("withMarker refuses a marker that could escape the expression", () => {
    expect(() => withMarker('x"});alert(1)//')).toThrow();
    expect(() => withMarker("")).toThrow();
  });
});

describe("renderArtifact", () => {
  test("wraps the bundle in a function that calls installBootstrap on its global", () => {
    const bundle =
      "var recnrunBootstrap = { installBootstrap: (scope, options) => [typeof scope, options.marker] };";
    const artifact = renderArtifact(`${bundle}\n`, "9.9.9");
    const result = vm.runInNewContext(`${artifact.source}({ marker: "m" })`) as unknown[];
    expect([...result]).toEqual(["object", "m"]);
    expect(artifact.hash).toBe(createHash("sha256").update(artifact.source).digest("hex"));
    expect(renderModule(artifact)).toContain(`export const hash = "${artifact.hash}";`);
    expect(renderModule(artifact)).toContain('export const version = "9.9.9";');
  });
});
