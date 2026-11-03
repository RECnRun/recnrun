import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { MARKER_GLOBAL, ORIGINAL_GLOBAL, STRATEGY_GLOBAL } from "@/content/route-c/names";
import { extensionBaseOf, startRouteC, takeStrategy } from "@/content/route-c/start";
import { wrapConstructor, wrapperSource } from "@/content/route-c/wrap-workers";
import type { WorkerContext } from "@/content/route-c/wrap-workers";

const APP = "http://app.localhost:4600";
const BASE = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const STACK = `Error\n    at startRouteC (${BASE}route-c.js:1:2048)\n    at ${BASE}route-c.js:1:9`;
const IMPORTS = [`${BASE}ns/slot-3.js`, `${BASE}ns/workers-blob.js`, `${BASE}route-c.js`];

/** A worker constructor that records how it was called and runs nothing. */
function fakeConstructor() {
  const made: unknown[][] = [];
  class FakeWorker {
    constructor(...args: unknown[]) {
      made.push(args);
    }
  }
  return { FakeWorker, made };
}

function context(overrides: Partial<WorkerContext> = {}) {
  const blobs: Blob[] = [];
  const value: WorkerContext = {
    strategy: "blob",
    marker: "slot-3",
    base: BASE,
    baseUrl: () => `${APP}/workers.html?type=classic`,
    createObjectURL: (blob) => {
      blobs.push(blob);
      return `blob:${APP}/fake-${blobs.length}`;
    },
    ...overrides,
  };
  return { value, blobs };
}

/** What `new <kind>(url, options)` threw, as `name: message`. */
function refusalOf(construct: () => unknown): string {
  try {
    construct();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "constructed";
}

describe("Route C worker wrapper sources", () => {
  test("a classic wrapper imports the bootstrap files, then the original script", () => {
    expect(wrapperSource("classic", IMPORTS, `${APP}/worker.js?type=classic`)).toBe(
      [
        `importScripts(${IMPORTS.map((url) => JSON.stringify(url)).join(", ")});`,
        `importScripts("${APP}/worker.js?type=classic");`,
        "",
      ].join("\n"),
    );
  });

  test("a module wrapper imports the bootstrap files statically before the original", () => {
    expect(wrapperSource("module", IMPORTS, `${APP}/worker.js?type=module`)).toBe(
      [...IMPORTS, `${APP}/worker.js?type=module`].map((url) => `import "${url}";\n`).join(""),
    );
  });
});

describe("Route C worker constructors", () => {
  test("fail closed by default: the constructor throws and no worker starts", () => {
    const { FakeWorker, made } = fakeConstructor();
    const Wrapped = wrapConstructor(
      FakeWorker,
      "Worker",
      context({ strategy: "fail-closed" }).value,
    );
    expect(refusalOf(() => new Wrapped("/worker.js?type=classic", { type: "classic" }))).toBe(
      "SecurityError: RECnRun Route C refused new Worker(/worker.js?type=classic): " +
        "no wrapper keeps the worker's own self.location, baseURI, and relative imports",
    );
    expect(made).toEqual([]);
  });

  test("a blob wrapper starts a classic worker from an object URL with the options unchanged", async () => {
    const { FakeWorker, made } = fakeConstructor();
    const { value, blobs } = context();
    const Wrapped = wrapConstructor(FakeWorker, "Worker", value);
    const options = { type: "classic", name: "fixture" };
    const worker = new Wrapped("/worker.js?type=classic", options);
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker).toBeInstanceOf(Wrapped);
    expect(made).toEqual([[`blob:${APP}/fake-1`, options]]);
    expect(blobs[0]?.type).toBe("text/javascript");
    expect(await blobs[0]?.text()).toBe(
      wrapperSource("classic", IMPORTS, `${APP}/worker.js?type=classic`),
    );
  });

  test("a module worker gets a module wrapper, and a shared worker keeps its name", async () => {
    const { FakeWorker, made } = fakeConstructor();
    const { value, blobs } = context();
    const Wrapped = wrapConstructor(FakeWorker, "SharedWorker", value);
    new Wrapped(`${APP}/shared-worker.js?type=module`, { type: "module" });
    new Wrapped("/shared-worker.js?type=classic", "fixture-name");
    expect(made.map(([, options]) => options)).toEqual([{ type: "module" }, "fixture-name"]);
    expect(await blobs[0]?.text()).toBe(
      wrapperSource("module", IMPORTS, `${APP}/shared-worker.js?type=module`),
    );
    expect(await blobs[1]?.text()).toBe(
      wrapperSource("classic", IMPORTS, `${APP}/shared-worker.js?type=classic`),
    );
  });

  test("a data wrapper encodes the same wrapper, with its own strategy file, in a data: URL", () => {
    const { FakeWorker, made } = fakeConstructor();
    const { value, blobs } = context({ strategy: "data" });
    new (wrapConstructor(FakeWorker, "Worker", value))("/worker.js?type=classic");
    const [url] = made[0] ?? [];
    const prefix = "data:text/javascript;charset=utf-8,";
    const imports = IMPORTS.map((file) => file.replace("workers-blob", "workers-data"));
    expect(String(url).startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(String(url).slice(prefix.length))).toBe(
      wrapperSource("classic", imports, `${APP}/worker.js?type=classic`),
    );
    expect(blobs).toEqual([]);
  });

  test.each<[string, Partial<WorkerContext>, string]>([
    [
      "the bootstrap failed",
      { refusal: "bootstrap failed: bad marker" },
      "bootstrap failed: bad marker",
    ],
    ["the extension base is unknown", { base: undefined }, "the extension base URL is unknown"],
    [
      "the script URL does not resolve",
      { baseUrl: () => "blob:http://app.localhost:4600/x" },
      "the script URL does not resolve against blob:http://app.localhost:4600/x",
    ],
  ])("refuses every worker when %s", (_, overrides, reason) => {
    const { FakeWorker, made } = fakeConstructor();
    const Wrapped = wrapConstructor(FakeWorker, "SharedWorker", context(overrides).value);
    expect(refusalOf(() => new Wrapped("worker.js"))).toBe(
      `SecurityError: RECnRun Route C refused new SharedWorker(worker.js): ${reason}`,
    );
    expect(made).toEqual([]);
  });
});

/** A window at document_start: native constructors and storage, nothing patched yet. */
function fakeWindow(extra: Record<string, unknown> = {}) {
  const worker = fakeConstructor();
  const shared = fakeConstructor();
  const blobs: Blob[] = [];
  const scope: Record<string, unknown> = {
    location: { href: `${APP}/workers.html?type=classic` },
    document: { baseURI: `${APP}/workers.html?type=classic` },
    fetch: vi.fn(async () => new Response(null)),
    URL: {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return `blob:${APP}/fake-${blobs.length}`;
      },
    },
    [MARKER_GLOBAL]: "slot-3",
    ...extra,
  };
  for (const [name, fake] of [
    ["Worker", worker.FakeWorker],
    ["SharedWorker", shared.FakeWorker],
  ] as const) {
    Object.defineProperty(scope, name, { value: fake, writable: true, configurable: true });
  }
  return { scope, worker, shared, blobs };
}

describe("Route C page start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("finds the extension base in a stack, or nothing outside an extension", () => {
    expect(extensionBaseOf(STACK)).toBe(BASE);
    expect(extensionBaseOf(`Error\n    at ${APP}/index.js:1:1`)).toBeUndefined();
    expect(extensionBaseOf(undefined)).toBeUndefined();
  });

  test("takes the worker strategy once and fails closed on anything unknown", () => {
    const scope: Record<string, unknown> = { [STRATEGY_GLOBAL]: "data" };
    expect(takeStrategy(scope)).toBe("data");
    expect(scope).toEqual({});
    expect(takeStrategy({ [STRATEGY_GLOBAL]: "eval" })).toBe("fail-closed");
    expect(takeStrategy({})).toBe("fail-closed");
  });

  test("installs the slot marker and wraps both constructors, exposing nothing new", async () => {
    const { scope, worker, blobs } = fakeWindow({ [STRATEGY_GLOBAL]: "blob" });
    const keys = Object.keys(scope).filter((key) => key !== STRATEGY_GLOBAL);
    startRouteC(scope, STACK);
    expect(Reflect.get(scope, "__recnrun")).toMatchObject({ marker: "slot-3" });
    expect(Object.keys(scope)).toEqual(keys);
    expect(Object.getOwnPropertyDescriptor(scope, "Worker")).toMatchObject({
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const Worker = Reflect.get(scope, "Worker") as new (url: string) => unknown;
    new Worker("/worker.js?type=classic");
    expect(worker.made).toEqual([[`blob:${APP}/fake-1`]]);
    expect(await blobs[0]?.text()).toBe(
      wrapperSource("classic", IMPORTS, `${APP}/worker.js?type=classic`),
    );
  });

  test("the original slot installs the original-session filter, and workers import that slot", async () => {
    const { scope, worker, blobs } = fakeWindow({
      [STRATEGY_GLOBAL]: "blob",
      [ORIGINAL_GLOBAL]: true,
    });
    Reflect.deleteProperty(scope, MARKER_GLOBAL);
    startRouteC(scope, STACK);
    expect(Reflect.get(scope, "__recnrun")).toMatchObject({ original: true });
    expect(ORIGINAL_GLOBAL in scope).toBe(false);
    const Worker = Reflect.get(scope, "Worker") as new (url: string) => unknown;
    new Worker("/worker.js?type=classic");
    expect(worker.made).toEqual([[`blob:${APP}/fake-1`]]);
    const imports = [`${BASE}ns/original.js`, ...IMPORTS.slice(1)];
    expect(await blobs[0]?.text()).toBe(
      wrapperSource("classic", imports, `${APP}/worker.js?type=classic`),
    );
  });

  test("without a valid marker it reports the failure, never throws, and refuses workers", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { scope, shared } = fakeWindow({ [MARKER_GLOBAL]: "not a marker" });
    expect(() => startRouteC(scope, STACK)).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^RECnRun Route C: bootstrap failed: /),
    );
    const SharedWorker = Reflect.get(scope, "SharedWorker") as new (url: string) => unknown;
    expect(refusalOf(() => new SharedWorker("/shared-worker.js"))).toMatch(
      /^SecurityError: RECnRun Route C refused new SharedWorker\(\/shared-worker\.js\): bootstrap failed: /,
    );
    expect(shared.made).toEqual([]);
  });

  test("never throws into the page when a constructor cannot be replaced", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { scope } = fakeWindow();
    const { FakeWorker } = fakeConstructor();
    Object.defineProperty(scope, "Worker", {
      value: FakeWorker,
      writable: false,
      configurable: false,
    });
    expect(() => startRouteC(scope, STACK)).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^RECnRun Route C: cannot wrap Worker: /),
    );
    expect(Reflect.get(scope, "Worker")).toBe(FakeWorker);
  });
});
