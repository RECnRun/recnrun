import type { IdentityData, ManagedWindowState } from "@recnrun/domain";
import { describe, expect, test } from "vite-plus/test";
import {
  RESPONSE_URL_PAGE,
  RESPONSE_URL_RELAY,
  answerResponseUrls,
  exposeResponseUrls,
  responseUrlsOf,
  withdrawResponseUrls,
} from "@/background/workspace/response-urls";
import { fakeBarrierApi } from "./fake-barrier";
import { memoryResponseUrls } from "./fake-helper";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";

function entry(request: string, url: string) {
  const response = { status: 200, statusText: "OK", headers: [], body: null };
  return {
    request: { url: request, method: "GET", headers: [] },
    response: { ...response, type: "default" as const, url, redirected: false },
  };
}

const DATA: IdentityData = {
  cookies: [],
  site: {
    localStorage: {},
    sessionStorage: {},
    indexedDB: [],
    caches: [
      { name: "pages", entries: [entry(`${APP}/a`, `${APP}/a`), entry(`${APP}/built`, "")] },
      { name: "api", entries: [entry(`${APP}/r`, `${APP}/a?via=redirect`)] },
    ],
  },
  origins: [
    {
      origin: OTHER,
      localStorage: {},
      sessionStorage: {},
      indexedDB: [],
      caches: [{ name: "x", entries: [entry(`${OTHER}/b`, `${OTHER}/b`)] }],
    },
    {
      origin: "http://none.localhost:5192",
      localStorage: {},
      sessionStorage: {},
      indexedDB: [],
      caches: [],
    },
  ],
};

const URLS = {
  [APP]: [
    [`${APP}/a`, `${APP}/a`],
    [`${APP}/r`, `${APP}/a?via=redirect`],
  ],
  [OTHER]: [[`${OTHER}/b`, `${OTHER}/b`]],
} satisfies Record<string, [string, string][]>;

const ACTIVE: ManagedWindowState = { generation: 4, windowId: 5, tabId: 9, status: "active" };

describe("responseUrlsOf", () => {
  test("names each fetched entry's URL per origin, and no built entry or empty origin", () => {
    expect(responseUrlsOf(APP, DATA)).toEqual(URLS);
  });
});

describe("exposeResponseUrls", () => {
  test("keeps the URLs, then registers the relay and the page script on their origins only", async () => {
    const barrier = fakeBarrierApi();
    const responseUrls = memoryResponseUrls();
    await exposeResponseUrls(4, URLS, { barrier, responseUrls });

    expect(await responseUrls.read(4)).toEqual(URLS);
    const scripts = [...barrier.scripts.values()];
    expect(scripts.map(({ js, world }) => [js, world])).toEqual([
      [[RESPONSE_URL_RELAY], "ISOLATED"],
      [[RESPONSE_URL_PAGE], "MAIN"],
    ]);
    for (const script of scripts) {
      expect(script).toMatchObject({
        matches: [`${APP}/*`, `${OTHER}/*`],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: false,
      });
    }
  });

  test("replaces an earlier start's scripts, and registers none when no entry was fetched", async () => {
    const barrier = fakeBarrierApi();
    const responseUrls = memoryResponseUrls();
    await exposeResponseUrls(3, URLS, { barrier, responseUrls });
    await exposeResponseUrls(4, URLS, { barrier, responseUrls });
    expect(barrier.scripts.size).toBe(2);

    await exposeResponseUrls(5, {}, { barrier, responseUrls });
    expect(barrier.scripts.size).toBe(0);
    expect(await responseUrls.read(5)).toEqual({});
    expect(await responseUrls.read(4)).toEqual({});
  });

  test("registers neither script when Chrome refuses one", async () => {
    const barrier = fakeBarrierApi();
    let registered = 0;
    const register = barrier.registerScript;
    barrier.registerScript = async (script) => {
      if (registered++ === 1) throw new Error("Refused.");
      await register(script);
    };
    const refused = exposeResponseUrls(4, URLS, { barrier, responseUrls: memoryResponseUrls() });
    await expect(refused).rejects.toThrow("Refused.");
    expect(barrier.scripts.size).toBe(0);
  });
});

describe("withdrawResponseUrls", () => {
  test("unregisters both scripts and leaves every other script registered", async () => {
    const barrier = fakeBarrierApi();
    await barrier.registerScript({
      id: "recnrun-barrier",
      js: ["x.js"],
      matches: [`${APP}/*`],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: false,
    });
    await exposeResponseUrls(4, URLS, { barrier, responseUrls: memoryResponseUrls() });
    await withdrawResponseUrls(barrier);
    await withdrawResponseUrls(barrier);
    expect([...barrier.scripts.keys()]).toEqual(["recnrun-barrier"]);
  });
});

describe("answerResponseUrls", () => {
  const deps = (managed: ManagedWindowState | null) => ({
    responseUrls: memoryResponseUrls(4, URLS),
    managed: async () => managed,
  });
  const incognito = (origin?: string) => ({ tab: { incognito: true } as never, origin });

  test("answers the sender frame's origin while the managed session is open", async () => {
    expect(await answerResponseUrls(incognito(OTHER), deps(ACTIVE))).toEqual(URLS[OTHER]);
    expect(await answerResponseUrls(incognito("http://none.localhost:5192"), deps(ACTIVE))).toEqual(
      [],
    );
  });

  test("answers nothing to a normal tab, a frame without an origin, or a closed session", async () => {
    const normal = { tab: { incognito: false } as never, origin: APP };
    expect(await answerResponseUrls(normal, deps(ACTIVE))).toEqual([]);
    expect(await answerResponseUrls(incognito(), deps(ACTIVE))).toEqual([]);
    expect(await answerResponseUrls(incognito(APP), deps(null))).toEqual([]);
    const closed = { ...ACTIVE, status: "closed" as const };
    expect(await answerResponseUrls(incognito(APP), deps(closed))).toEqual([]);
    const later = { ...ACTIVE, generation: 5 };
    expect(await answerResponseUrls(incognito(APP), deps(later))).toEqual([]);
  });
});
