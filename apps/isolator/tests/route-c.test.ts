import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { ROUTE_C_SCRIPT_ID, RouteCEngine } from "@/background/route-c/engine";
import { APP_MATCHES } from "@/background/route-c/requests";
import { SLOT_COUNT } from "@/content/route-c/names";
import { fakeScripting } from "./fake-scripting";

const ISOLATOR = fileURLToPath(new URL("..", import.meta.url));

function setup() {
  const fake = fakeScripting();
  return { ...fake, engine: new RouteCEngine(() => fake.api) };
}

describe("Route C registration", () => {
  test("install registers one MAIN-world script at document_start on every frame", async () => {
    const { engine, registered } = setup();
    expect(await engine.install({ marker: "e7-page-0" })).toBe("slot-0");
    expect([...registered.values()]).toEqual([
      {
        id: ROUTE_C_SCRIPT_ID,
        matches: APP_MATCHES,
        js: ["ns/slot-0.js", "route-c.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: false,
      },
    ]);
    expect(await engine.registered()).toEqual([...registered.values()]);
  });

  test("a worker strategy adds its file between the slot and the bootstrap", async () => {
    const { engine, registered } = setup();
    const matches = ["http://app.localhost:4600/*", "http://idp.localhost:4602/*"];
    await engine.install({ marker: "e7-w", matches, workers: "blob" });
    expect(registered.get(ROUTE_C_SCRIPT_ID)).toMatchObject({
      matches,
      js: ["ns/slot-0.js", "ns/workers-blob.js", "route-c.js"],
    });
  });

  test("install replaces an earlier registration instead of failing on the duplicate id", async () => {
    const { engine, registered, calls } = setup();
    await engine.install({ marker: "first" });
    expect(await engine.install({ marker: "second", workers: "data" })).toBe("slot-1");
    expect(calls).toEqual(["register", "unregister", "register"]);
    expect(registered.get(ROUTE_C_SCRIPT_ID)?.js).toEqual([
      "ns/slot-1.js",
      "ns/workers-data.js",
      "route-c.js",
    ]);
  });

  test("setMarker moves the registration to the next slot, so consecutive loads differ", async () => {
    const { engine, registered, calls } = setup();
    await engine.install({ marker: "m-0", workers: "blob" });
    const slots = [];
    for (let index = 1; index <= SLOT_COUNT; index += 1) {
      slots.push(await engine.setMarker({ marker: `m-${index}` }));
    }
    expect(slots).toEqual([...Array.from({ length: 9 }, (_, k) => `slot-${k + 1}`), "slot-0"]);
    expect(calls.filter((call) => call === "update")).toHaveLength(SLOT_COUNT);
    expect(registered.get(ROUTE_C_SCRIPT_ID)?.js).toEqual([
      "ns/slot-0.js",
      "ns/workers-blob.js",
      "route-c.js",
    ]);
  });

  test("setMarker before install is refused", async () => {
    const { engine, calls } = setup();
    await expect(engine.setMarker({ marker: "early" })).rejects.toThrow("Route C is not installed");
    expect(calls).toEqual([]);
  });

  test.each<[string, unknown]>([
    ["a marker outside the alphabet", { marker: "not a marker" }],
    ["no marker", {}],
    ["a host outside the loopback", { marker: "m", matches: ["https://example.com/*"] }],
    ["a loopback lookalike", { marker: "m", matches: ["http://127.0.0.1.example.com/*"] }],
    ["every URL", { marker: "m", matches: ["<all_urls>"] }],
    ["a pattern without its path", { marker: "m", matches: ["http://app.localhost:4600/"] }],
    ["no pattern", { marker: "m", matches: [] }],
    ["an unknown worker strategy", { marker: "m", workers: "eval" }],
  ])("install refuses %s before any chrome.scripting call", async (_, request) => {
    const { engine, calls } = setup();
    await expect(engine.install(request)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("setOriginal points the registration at the original slot until the next setMarker", async () => {
    const { engine, registered } = setup();
    await engine.install({ marker: "m", workers: "blob" });
    expect(await engine.setOriginal()).toBe("original");
    expect(registered.get(ROUTE_C_SCRIPT_ID)?.js).toEqual([
      "ns/original.js",
      "ns/workers-blob.js",
      "route-c.js",
    ]);
    expect(await engine.setMarker({ marker: "m" })).toBe("slot-1");
  });

  test("setOriginal before install is refused", async () => {
    const { engine, calls } = setup();
    await expect(engine.setOriginal()).rejects.toThrow("Route C is not installed");
    expect(calls).toEqual([]);
  });

  test("uninstall removes the registration, and a later setMarker is refused", async () => {
    const { engine, registered } = setup();
    await engine.install({ marker: "m" });
    await engine.uninstall();
    expect(registered.size).toBe(0);
    expect(await engine.registered()).toEqual([]);
    await expect(engine.setMarker({ marker: "after" })).rejects.toThrow("Route C is not installed");
  });
});

describe("Route C manifest and slot files", () => {
  test("the manifest grants scripting on the app origins and exposes the worker imports there", async () => {
    const config = (await import(pathToFileURL(`${ISOLATOR}wxt.config.ts`).href)) as {
      default: { manifest: Record<string, unknown> };
    };
    const { permissions, host_permissions, web_accessible_resources } = config.default.manifest;
    expect(permissions).toContain("scripting");
    expect(host_permissions).toEqual(expect.arrayContaining(APP_MATCHES));
    expect(web_accessible_resources).toContainEqual({
      resources: ["route-c.js", "ns/*.js"],
      matches: APP_MATCHES,
    });
  });

  test("each slot file sets only its own marker, and each strategy file only its name", async () => {
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      expect(await readFile(`${ISOLATOR}public/ns/slot-${slot}.js`, "utf8")).toBe(
        `globalThis.__recnrunMarker = "slot-${slot}";\n`,
      );
    }
    expect(await readFile(`${ISOLATOR}public/ns/original.js`, "utf8")).toBe(
      "globalThis.__recnrunOriginal = true;\n",
    );
    for (const strategy of ["blob", "data"]) {
      expect(await readFile(`${ISOLATOR}public/ns/workers-${strategy}.js`, "utf8")).toBe(
        `globalThis.__recnrunWorkers = "${strategy}";\n`,
      );
    }
  });
});
