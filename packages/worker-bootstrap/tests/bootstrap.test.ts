import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, test } from "vite-plus/test";
import { renderArtifact, renderModule } from "../src/artifact.ts";
import { BOOTSTRAP_HASH, BOOTSTRAP_SOURCE, BOOTSTRAP_VERSION, withMarker } from "../src/index.ts";

const SCRIPT = "http://app.localhost:4600/sw-main.js?variant=classic";
const ME = "http://api.localhost:4601/me?from=%2Fsw-main.js%3Fvariant%3Dclassic";

/** A worker-like global in its own realm: only JavaScript builtins plus these fakes. */
function workerRealm() {
  const effects: string[] = [];
  const sandbox: Record<string, unknown> = {
    URL,
    Request,
    location: { href: SCRIPT },
    fetch(input: unknown) {
      effects.push(`fetch ${input instanceof Request ? input.url : String(input)}`);
      return Promise.resolve(undefined);
    },
    indexedDB: {
      open: (name: string) => effects.push(`indexedDB.open ${name}`),
      deleteDatabase: (name: string) => effects.push(`indexedDB.deleteDatabase ${name}`),
      databases: () => Promise.resolve([]),
    },
    caches: {
      open: (name: string) => effects.push(`caches.open ${name}`),
      has: () => Promise.resolve(false),
      delete: () => Promise.resolve(false),
      keys: () => Promise.resolve([]),
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

  test("withMarker refuses a marker that could escape the expression", () => {
    expect(() => withMarker('x"});alert(1)//')).toThrow();
    expect(() => withMarker("")).toThrow();
  });
});

describe("renderArtifact", () => {
  test("wraps the bundle in a function that calls installMarker on its global", () => {
    const bundle =
      "var recnrunBootstrap = { installMarker: (scope, options) => [typeof scope, options.marker] };";
    const artifact = renderArtifact(`${bundle}\n`, "9.9.9");
    const result = vm.runInNewContext(`${artifact.source}({ marker: "m" })`) as unknown[];
    expect([...result]).toEqual(["object", "m"]);
    expect(artifact.hash).toBe(createHash("sha256").update(artifact.source).digest("hex"));
    expect(renderModule(artifact)).toContain(`export const hash = "${artifact.hash}";`);
    expect(renderModule(artifact)).toContain('export const version = "9.9.9";');
  });
});
