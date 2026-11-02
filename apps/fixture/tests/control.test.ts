import { afterEach, describe, expect, test } from "vite-plus/test";
import { local, useFixture } from "./harness.ts";

const fixture = useFixture();
const { ledger, signIn, me } = fixture;

function network(mode?: "offline" | "online" | "nowhere") {
  const query = mode === undefined ? "" : `?mode=${mode}`;
  return fetch(local(`${fixture.origins.api}/__network${query}`), {
    method: mode === undefined ? "GET" : "POST",
  });
}

function outcome(url: string, init?: RequestInit): Promise<number | string> {
  return fetch(local(url), init).then(
    (response) => response.status,
    (error: unknown) => (error instanceof TypeError ? "network error" : String(error)),
  );
}

describe("network cut", () => {
  afterEach(async () => {
    await network("online");
  });

  test("reports the mode and refuses an unknown one", async () => {
    expect(await (await network()).json()).toEqual({ mode: "online" });
    expect(await (await network("offline")).json()).toEqual({ mode: "offline" });
    expect(await (await network()).json()).toEqual({ mode: "offline" });
    expect((await network("nowhere")).status).toBe(400);
  });

  test("offline drops app, staging, and API requests without a response", async () => {
    const { apiCookie } = await signIn("alice");
    await network("offline");

    expect(await outcome(`${fixture.origins.app}/`)).toBe("network error");
    expect(await outcome(`${fixture.origins.staging}/page.js`)).toBe("network error");
    expect(await outcome(`${fixture.origins.api}/me`, { headers: { cookie: apiCookie } })).toBe(
      "network error",
    );
    const dropped = (await ledger()).filter((entry) => entry.effect === "network:dropped");
    expect(dropped.map((entry) => entry.origin)).toEqual([
      fixture.origins.app,
      fixture.origins.staging,
      fixture.origins.api,
    ]);
  });

  test("offline keeps the identity provider and the control routes reachable", async () => {
    await network("offline");

    expect(await outcome(`${fixture.origins.idp}/whoami`)).toBe(200);
    expect(await outcome(`${fixture.origins.app}/__marker?name=offline`)).toBe(204);
    expect(await outcome(`${fixture.origins.api}/__ledger`)).toBe(200);
  });

  test("going offline closes open streams and refuses new WebSocket upgrades", async () => {
    const stream = await fetch(local(`${fixture.origins.api}/events`));
    const reader = stream.body?.getReader();
    await reader?.read();
    await network("offline");
    const next = await reader?.read().then(
      (chunk) => (chunk.done ? "closed" : "data"),
      () => "closed",
    );
    const socket = new WebSocket(local(`${fixture.origins.api}/ws`).replace("http:", "ws:"));
    const upgrade = await new Promise<string>((resolve) => {
      socket.addEventListener("open", () => resolve("open"));
      socket.addEventListener("error", () => resolve("error"));
    });

    expect(next).toBe("closed");
    expect(upgrade).toBe("error");
  });

  test("back online, requests are answered again", async () => {
    await network("offline");
    expect(await outcome(`${fixture.origins.app}/`)).toBe("network error");
    expect(await (await network("online")).json()).toEqual({ mode: "online" });

    expect(await outcome(`${fixture.origins.app}/`)).toBe(200);
  });
});

describe("server-side expiry", () => {
  test("expiring a user ends its API and IdP sessions and leaves other users signed in", async () => {
    const frank = await signIn("frank");
    const bob = await signIn("bob");
    const expire = await fetch(local(`${fixture.origins.api}/__expire?user=frank`), {
      method: "POST",
    });
    const whoami = await fetch(local(`${fixture.origins.idp}/whoami`), {
      headers: { cookie: frank.idpCookie },
    });
    const renew = await fetch(local(`${fixture.origins.idp}/renew`), {
      method: "POST",
      headers: { cookie: frank.idpCookie },
    });

    expect(await expire.json()).toEqual({ user: "frank", expired: 2 });
    expect(await me(frank.apiCookie)).toEqual({ status: 401, body: { user: null } });
    expect(await whoami.json()).toEqual({ user: null });
    expect(renew.status).toBe(401);
    expect((await me(bob.apiCookie)).body).toEqual({ user: "bob" });
  });

  test("expiry needs a user", async () => {
    const response = await fetch(local(`${fixture.origins.api}/__expire`), { method: "POST" });

    expect(response.status).toBe(400);
  });
});
