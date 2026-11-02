import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import type { LedgerEntry } from "@/ledger.ts";
import { startFixture, type Fixture } from "@/server.ts";

const EPHEMERAL = { app: 0, api: 0, idp: 0, staging: 0 };
let fixture: Fixture;

// *.localhost does not resolve in every container, so tests reach the listeners on 127.0.0.1.
function local(url: string): string {
  return url.replace(/\/\/[a-z]+\.localhost:/, "//127.0.0.1:");
}

function location(response: Response): string {
  const value = response.headers.get("location");
  if (!value) throw new Error(`No Location header on ${response.url} (${response.status})`);
  return value;
}

function cookieOf(response: Response): string {
  const [first = ""] = response.headers.getSetCookie();
  return first.split(";")[0] ?? "";
}

async function ledger(): Promise<LedgerEntry[]> {
  const response = await fetch(local(`${fixture.origins.api}/__ledger`));
  return (await response.json()) as LedgerEntry[];
}

async function signIn(username: string) {
  const login = await fetch(local(`${fixture.origins.idp}/login`), {
    method: "POST",
    body: new URLSearchParams({ username, redirect: `${fixture.origins.app}/` }),
    redirect: "manual",
  });
  const session = await fetch(local(location(login)), { redirect: "manual" });
  return { login, session, idpCookie: cookieOf(login), apiCookie: cookieOf(session) };
}

async function me(cookie: string) {
  const response = await fetch(local(`${fixture.origins.api}/me`), { headers: { cookie } });
  return { status: response.status, body: (await response.json()) as { user: string | null } };
}

beforeAll(async () => {
  fixture = await startFixture({ ports: EPHEMERAL });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await fetch(local(`${fixture.origins.api}/__ledger/reset`), { method: "POST" });
});

describe("identity provider and API session", () => {
  test("logging in redirects through the API session exchange back to the app", async () => {
    const { login, session, apiCookie } = await signIn("alice");

    expect(login.status).toBe(302);
    expect(location(login)).toMatch(/^http:\/\/api\.localhost:\d+\/session\?code=/);
    expect(session.status).toBe(302);
    expect(location(session)).toBe(`${fixture.origins.app}/`);
    expect(await me(apiCookie)).toEqual({ status: 200, body: { user: "alice" } });
  });

  test("session cookies are host-only, HttpOnly, Secure, and SameSite=None", async () => {
    const { login, session } = await signIn("alice");

    for (const response of [login, session]) {
      const [cookie = ""] = response.headers.getSetCookie();
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; SameSite=None/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
  });

  test("without a session the API answers 401 with no user", async () => {
    expect(await me("")).toEqual({ status: 401, body: { user: null } });
  });

  test("login refuses a missing username or a redirect outside the fixture", async () => {
    const post = (body: Record<string, string>) =>
      fetch(local(`${fixture.origins.idp}/login`), {
        method: "POST",
        body: new URLSearchParams(body),
        redirect: "manual",
      });

    expect((await post({ username: "", redirect: `${fixture.origins.app}/` })).status).toBe(400);
    expect((await post({ username: "eve", redirect: "http://evil.example/" })).status).toBe(400);
  });

  test("a session code works once", async () => {
    const login = await fetch(local(`${fixture.origins.idp}/login`), {
      method: "POST",
      body: new URLSearchParams({ username: "bob", redirect: `${fixture.origins.staging}/` }),
      redirect: "manual",
    });
    const exchange = local(location(login));

    expect((await fetch(exchange, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(exchange, { redirect: "manual" })).status).toBe(400);
  });

  test("whoami and silent renew rotate the identity provider session", async () => {
    const { idpCookie } = await signIn("carol");
    const whoami = await fetch(local(`${fixture.origins.idp}/whoami`), {
      headers: { cookie: idpCookie },
    });
    const renew = await fetch(local(`${fixture.origins.idp}/renew`), {
      method: "POST",
      headers: { cookie: idpCookie },
    });
    const stale = await fetch(local(`${fixture.origins.idp}/renew`), {
      method: "POST",
      headers: { cookie: idpCookie },
    });

    expect(await whoami.json()).toEqual({ user: "carol" });
    expect(await renew.json()).toEqual({ user: "carol", renewed: true });
    expect(cookieOf(renew)).not.toBe(idpCookie);
    expect(stale.status).toBe(401);
  });

  test("logout clears the identity provider and API sessions", async () => {
    const { idpCookie, apiCookie } = await signIn("dave");
    const idpLogout = await fetch(
      local(`${fixture.origins.idp}/logout?redirect=${encodeURIComponent(fixture.origins.app)}`),
      { headers: { cookie: idpCookie }, redirect: "manual" },
    );
    const apiLogout = await fetch(local(location(idpLogout)), {
      headers: { cookie: apiCookie },
      redirect: "manual",
    });

    expect(location(apiLogout)).toBe(fixture.origins.app);
    expect(cookieOf(idpLogout)).toBe("idp_sid=");
    expect(cookieOf(apiLogout)).toBe("api_sid=");
    expect((await me(apiCookie)).status).toBe(401);
  });
});

describe("API endpoints", () => {
  test("the slow endpoint waits at least the requested time", async () => {
    const { apiCookie } = await signIn("alice");
    const started = performance.now();
    const response = await fetch(local(`${fixture.origins.api}/slow?ms=200`), {
      headers: { cookie: apiCookie },
    });

    expect(await response.json()).toEqual({ user: "alice", ms: 200 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
  });

  test("the redirect chain ends at /me", async () => {
    const { apiCookie } = await signIn("alice");
    const response = await fetch(local(`${fixture.origins.api}/redirect/3`), {
      headers: { cookie: apiCookie },
    });
    const paths = (await ledger()).map((entry) => entry.path).filter((path) => path !== "/me");

    expect(new URL(response.url).pathname).toBe("/me");
    expect(await response.json()).toEqual({ user: "alice" });
    expect(paths.slice(-3)).toEqual(["/redirect/3", "/redirect/2", "/redirect/1"]);
  });

  test("the private response is cacheable per user and varies on Cookie", async () => {
    const { apiCookie } = await signIn("alice");
    const response = await fetch(local(`${fixture.origins.api}/private`), {
      headers: { cookie: apiCookie },
    });

    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("vary")).toMatch(/\bCookie\b/);
    expect(await response.json()).toMatchObject({ user: "alice" });
  });

  test("an action is a side effect the ledger records once per request", async () => {
    const { apiCookie } = await signIn("erin");
    const act = () =>
      fetch(local(`${fixture.origins.api}/act?op=save`), {
        method: "POST",
        headers: { cookie: apiCookie },
      });

    expect(await (await act()).json()).toEqual({ user: "erin", op: "save", count: 1 });
    expect(await (await act()).json()).toEqual({ user: "erin", op: "save", count: 2 });
    const effects = (await ledger()).filter((entry) => entry.effect === "act:save");
    expect(effects.map((entry) => entry.user)).toEqual(["erin", "erin"]);
  });

  test("CORS allows credentials only for fixture origins", async () => {
    const preflight = (origin: string) =>
      fetch(local(`${fixture.origins.api}/act`), {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      });
    const allowed = await preflight(fixture.origins.staging);
    const refused = await preflight("http://evil.example");

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(fixture.origins.staging);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("EventSource streams the user first", async () => {
    const { apiCookie } = await signIn("alice");
    const response = await fetch(local(`${fixture.origins.api}/events`), {
      headers: { cookie: apiCookie },
    });
    const reader = response.body?.getReader();
    const { value } = (await reader?.read()) ?? {};
    await reader?.cancel();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(new TextDecoder().decode(value)).toContain('event: hello\ndata: {"user":"alice"}\n\n');
  });

  test("the WebSocket endpoint echoes short and long messages", async () => {
    const socket = new WebSocket(local(`${fixture.origins.api}/ws`).replace("http:", "ws:"));
    const messages = ["ping", "m".repeat(300), "l".repeat(70_000)];
    const echoes = await new Promise<unknown[]>((resolve, reject) => {
      const received: unknown[] = [];
      socket.addEventListener("open", () => messages.forEach((message) => socket.send(message)));
      socket.addEventListener("message", (event) => {
        received.push(event.data);
        if (received.length === messages.length) resolve(received);
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
    });
    socket.close();

    expect(echoes).toEqual(messages);
    expect((await ledger()).some((entry) => entry.path === "/ws")).toBe(true);
  });

  test("upgrades other than the API's /ws are refused", async () => {
    const socket = new WebSocket(local(`${fixture.origins.app}/ws`).replace("http:", "ws:"));
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener("open", () => resolve("open"));
      socket.addEventListener("error", () => resolve("error"));
    });

    expect(outcome).toBe("error");
  });
});

describe("ledger", () => {
  test("entries carry identity, hashed cookies, Sec-Fetch headers, and order", async () => {
    const { apiCookie } = await signIn("alice");
    await fetch(local(`${fixture.origins.api}/me`), {
      headers: {
        cookie: apiCookie,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
      },
    });
    const entries = await ledger();
    const entry = entries.at(-1);

    expect(entry).toMatchObject({
      origin: fixture.origins.api,
      path: "/me",
      method: "GET",
      user: "alice",
      cookieHash: createHash("sha256").update(apiCookie).digest("hex"),
      secFetchDest: "empty",
      secFetchMode: "cors",
      secFetchSite: "same-site",
    });
    expect(entry?.cookieHash).not.toContain(apiCookie.split("=")[1]);
    const order = entries.map((item) => item.seq);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(typeof entry?.ts).toBe("number");
  });

  test("markers are recorded on every origin and the ledger never records itself", async () => {
    for (const origin of Object.values(fixture.origins)) {
      const response = await fetch(local(`${origin}/__marker?name=first-paint`));
      expect(response.status).toBe(204);
    }
    const entries = await ledger();

    expect(entries.map((entry) => [entry.origin, entry.marker])).toEqual(
      Object.values(fixture.origins).map((origin) => [origin, "first-paint"]),
    );
    expect(entries.every((entry) => entry.user === null && entry.cookieHash === null)).toBe(true);
  });

  test("reset empties the ledger", async () => {
    await fetch(local(`${fixture.origins.app}/__marker?name=before-reset`));
    expect(await ledger()).toHaveLength(1);

    await fetch(local(`${fixture.origins.api}/__ledger/reset`), { method: "POST" });
    expect(await ledger()).toEqual([]);
  });
});

describe("static files", () => {
  test("the app and its staging copy serve the same files", async () => {
    const app = await fetch(local(`${fixture.origins.app}/sw-main.js`));
    const staging = await fetch(local(`${fixture.origins.staging}/sw-main.js`));

    expect(app.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await app.text()).toBe(await staging.text());
  });

  test("the root serves the app page and the IdP serves its login form", async () => {
    const app = await fetch(local(`${fixture.origins.app}/`));
    const idp = await fetch(local(`${fixture.origins.idp}/login?redirect=x`));

    expect(await app.text()).toContain("<title>Fixture app</title>");
    expect(await idp.text()).toContain('name="username"');
  });

  test("paths outside the public folder are not served", async () => {
    for (const path of ["/missing.js", "/%2e%2e/package.json", "/%E0%A4%A"]) {
      expect((await fetch(local(`${fixture.origins.app}${path}`))).status).toBe(404);
    }
  });
});
