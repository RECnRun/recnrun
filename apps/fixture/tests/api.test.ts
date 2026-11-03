import { describe, expect, test } from "vite-plus/test";
import { useFixture } from "./harness.ts";

const fixture = useFixture();
const get = (path: string, init?: RequestInit) => fetch(`${fixture.urls.first}${path}`, init);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function readChunks(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No body");
  const decoder = new TextDecoder();
  let text = "";
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

describe("JSON, binary, and errors", () => {
  test("tells a page both origins", async () => {
    const response = await get("/api/config");
    expect(await response.json()).toEqual({
      origin: fixture.urls.first,
      secondOrigin: fixture.urls.second,
    });
  });

  test("answers JSON, or 500 with ?fail=api-500", async () => {
    const ok = await get("/api/json");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await ok.json()).toEqual({ ok: true, items: ["alpha", "beta", "gamma"] });
    const failed = await get("/api/json?fail=api-500");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false, error: "Injected failure (fail=api-500)" });
  });

  test("serves a PNG", async () => {
    const response = await get("/api/binary");
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
  });

  test("answers 500 on the error endpoint", async () => {
    const response = await get("/api/error");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "Server error on purpose" });
  });

  test("answers JSON 404 for an unknown endpoint", async () => {
    const response = await get("/api/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Not found" });
  });

  test("serves a fresh body each time for the service worker to cache", async () => {
    const first = (await (await get("/api/cacheable")).json()) as { serial: number };
    const second = (await (await get("/api/cacheable")).json()) as { serial: number };
    expect(second.serial).toBe(first.serial + 1);
  });
});

describe("redirects", () => {
  test("chains /api/redirect/3 to /2, /1, and /api/json", async () => {
    const hops: string[] = [];
    for (let path = "/api/redirect/3"; path !== "/api/json";) {
      const response = await get(path, { redirect: "manual" });
      expect(response.status).toBe(302);
      path = response.headers.get("location") ?? "";
      hops.push(path);
    }
    expect(hops).toEqual(["/api/redirect/2", "/api/redirect/1", "/api/json"]);
    const followed = await get("/api/redirect/3");
    expect(followed.redirected).toBe(true);
    expect(followed.url).toBe(`${fixture.urls.first}/api/json`);
  });

  test.each(["0", "11", "x"])("answers 404 for /api/redirect/%s", async (hops) => {
    expect((await get(`/api/redirect/${hops}`, { redirect: "manual" })).status).toBe(404);
  });
});

describe("stream and download", () => {
  test("streams 10 chunks over about 3 seconds", { timeout: 10_000 }, async () => {
    const started = Date.now();
    const text = await readChunks(await get("/api/stream"));
    expect(text.trimEnd().split("\n")).toEqual(
      Array.from({ length: 10 }, (_, index) => `chunk ${index + 1}`),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
  });

  test("slows the stream with ?fail=slow", { timeout: 10_000 }, async () => {
    const response = await get("/api/stream?fail=slow");
    const reader = response.body?.getReader();
    await reader?.read();
    const started = Date.now();
    await reader?.read();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    await reader?.cancel();
  });

  test("serves an attachment", async () => {
    const response = await get("/api/download");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="recnrun-fixture.txt"',
    );
    expect(await response.text()).toBe("RECnRun fixture download\n");
  });
});

describe("network evidence", () => {
  test("answers a body of the requested size, the same bytes every time", async () => {
    const text = await (await get("/api/large?bytes=40")).text();
    expect(text).toHaveLength(40);
    expect(text).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(await (await get("/api/large?bytes=40")).text()).toBe(text);
    expect(await (await get("/api/large?bytes=-3")).text()).toBe("");
  });

  test("answers the secret route with a cookie and a token header, never echoing either", async () => {
    const response = await get("/api/secret", { headers: { Authorization: "Bearer s3cr3t" } });
    expect(response.headers.get("set-cookie")).toMatch(
      /^fixture-session=s3cr3t-cookie;.*; HttpOnly/,
    );
    expect(response.headers.get("x-fixture-token")).toBe("s3cr3t-reply");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true, authorized: true });
    expect(body).not.toContain("s3cr3t");
    expect(await (await get("/api/secret")).json()).toEqual({ ok: true, authorized: false });
  });

  test("sets an HttpOnly cookie, and expires it with ?clear=1", async () => {
    const set = await get("/api/cookies");
    expect(set.headers.get("set-cookie")).toBe(
      "fixture-httponly=s3cr3t-httponly; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(await set.json()).toEqual({ httpOnly: "set" });
    const cleared = await get("/api/cookies?clear=1");
    expect(cleared.headers.get("set-cookie")).toBe(
      "fixture-httponly=; Path=/; HttpOnly; Max-Age=0",
    );
    expect(await cleared.json()).toEqual({ httpOnly: "cleared" });
  });

  test("lets the cached route be cached for a minute", async () => {
    const response = await get("/api/cached");
    expect(response.headers.get("cache-control")).toBe("max-age=60");
    expect(await response.json()).toEqual({ cached: true });
  });

  test("streams three server-sent events, a named one and a long one among them", async () => {
    const response = await get("/api/events");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text.split("\n\n").filter(Boolean)).toEqual([
      "retry: 60000",
      "data: hello fixture",
      "event: tick\nid: 7\ndata: tock",
      `data: ${"y".repeat(5_000)}`,
    ]);
  });

  test("drops the connection of the abort route without answering", async () => {
    await expect(get("/api/abort")).rejects.toThrow();
  });
});

describe("form POST", () => {
  test("answers 303 to the result page with the submitted fields", async () => {
    const response = await get("/api/submit", {
      method: "POST",
      body: new URLSearchParams({ name: "Ada Lovelace", plan: "pro" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/routes/submit-result?name=Ada+Lovelace&plan=pro",
    );
  });

  test("rejects a body over 64 KiB", async () => {
    const response = await get("/api/submit", {
      method: "POST",
      body: new URLSearchParams({ name: "x".repeat(70_000) }),
      redirect: "manual",
    });
    expect(response.status).toBe(413);
  });

  test("answers 405 to a GET", async () => {
    const response = await get("/api/submit");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("session", () => {
  const manual = (path: string, cookie?: string) =>
    get(path, { redirect: "manual", ...(cookie && { headers: { Cookie: cookie } }) });
  const COOKIE = "fixture-signed-in=yes";

  test("gates the account page behind a cookie that a sign in sets and an expiry clears", async () => {
    expect(await (await get("/api/session")).json()).toEqual({ signedIn: false });
    const expired = await manual("/routes/session");
    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toBe("/routes/session?login");
    expect((await get("/routes/session?login")).status).toBe(200);

    const signIn = await manual("/api/session?login");
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("set-cookie")).toBe(`${COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
    expect(signIn.headers.get("location")).toBe("/routes/session");
    expect((await manual("/routes/session", COOKIE)).status).toBe(200);
    expect(await (await manual("/api/session", COOKIE)).json()).toEqual({ signedIn: true });

    const expire = await manual("/api/session?expire", COOKIE);
    expect(expire.status).toBe(303);
    expect(expire.headers.get("set-cookie")).toBe(
      "fixture-signed-in=; Path=/; HttpOnly; Max-Age=0",
    );
    expect(expire.headers.get("location")).toBe("/routes/session");
  });
});
