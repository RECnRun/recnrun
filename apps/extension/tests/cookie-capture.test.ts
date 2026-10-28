import { describe, expect, test, vi } from "vite-plus/test";
import { captureCookies } from "@/background/workspace/cookie-capture";
import type { StoredCookie } from "@/background/workspace/cookie-stores";

/** A cookie as `cookies.getAll` answers: every field, `hostOnly` and `session` included. */
const stored = (cookie: Partial<StoredCookie>): StoredCookie => ({
  name: "sid",
  value: "abc",
  domain: "app.localhost",
  hostOnly: true,
  path: "/",
  secure: false,
  httpOnly: true,
  sameSite: "lax",
  session: true,
  ...cookie,
});

const HOSTS = { target: "app.localhost", extra: ["sso.localhost"] };
const jarOf = (cookies: StoredCookie[]) => ({ all: vi.fn(async () => cookies) });

describe("captureCookies", () => {
  test("reads the given store and keeps each cookie as cookies.set takes it back", async () => {
    const api = jarOf([
      stored({}),
      stored({
        name: "theme",
        domain: ".app.localhost",
        hostOnly: false,
        httpOnly: false,
        sameSite: "strict",
        session: false,
        expirationDate: 4_102_444_800.5,
      }),
      stored({
        name: "__Host-part",
        secure: true,
        sameSite: "no_restriction",
        partitionKey: { topLevelSite: "http://app.localhost", hasCrossSiteAncestor: false },
      }),
    ]);
    const jar = await captureCookies(api, "1", HOSTS, []);
    expect(api.all).toHaveBeenCalledExactlyOnceWith("1");
    expect(jar.unsupported).toEqual([]);
    expect(jar.cookies).toEqual([
      // Host-only on the target: no domain, so a restore sets it on the target's host.
      { name: "sid", value: "abc", path: "/", secure: false, httpOnly: true, sameSite: "lax" },
      {
        name: "theme",
        value: "abc",
        domain: ".app.localhost",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "strict",
        expirationDate: 4_102_444_800.5,
      },
      {
        name: "__Host-part",
        value: "abc",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        partitionKey: { topLevelSite: "http://app.localhost", hasCrossSiteAncestor: false },
      },
    ]);
  });

  test("keeps cookies that shadow each other by path, each with its own path", async () => {
    const jar = await captureCookies(
      jarOf([stored({ name: "shadow", path: "/deep" }), stored({ name: "shadow" })]),
      "1",
      HOSTS,
      [],
    );
    expect(jar.cookies.map(({ name, path }) => `${name}@${path}`)).toEqual([
      "shadow@/deep",
      "shadow@/",
    ]);
  });

  test("keeps a declared host's cookies, host-only ones with their host", async () => {
    const jar = await captureCookies(
      jarOf([
        stored({ name: "sso", domain: "sso.localhost" }),
        stored({ name: "wide", domain: ".localhost", hostOnly: false }),
        stored({ name: "parent", domain: ".sso.localhost", hostOnly: false }),
      ]),
      "1",
      HOSTS,
      [],
    );
    expect(jar.cookies.map(({ name, domain, host }) => ({ name, domain, host }))).toEqual([
      { name: "sso", domain: undefined, host: "sso.localhost" },
      { name: "wide", domain: ".localhost", host: undefined },
      { name: "parent", domain: ".sso.localhost", host: undefined },
    ]);
  });

  test("lists every other host's cookie as unsupported, by name and host, never its value", async () => {
    const jar = await captureCookies(
      jarOf([
        stored({ name: "ads", value: "secret-1", domain: "other.localhost" }),
        stored({ name: "sub", value: "secret-2", domain: ".deep.app.localhost", hostOnly: false }),
        stored({ name: "kept" }),
      ]),
      "1",
      { target: "app.localhost", extra: [] },
      [],
    );
    expect(jar.cookies.map(({ name }) => name)).toEqual(["kept"]);
    expect(jar.unsupported).toEqual([
      {
        adapter: "cookies",
        item: "ads on other.localhost/",
        reason: "Its host is neither the target's nor a declared cookie host.",
      },
      {
        adapter: "cookies",
        item: "sub on .deep.app.localhost/",
        reason: "Its host is neither the target's nor a declared cookie host.",
      },
    ]);
    expect(JSON.stringify(jar.unsupported)).not.toMatch(/secret/);
  });

  test("fails when the page shows a cookie Chrome did not list, naming it, never its value", async () => {
    // getAll leaves out a cookie whose domain the host permissions miss (cookies_helpers.cc:51-56).
    const api = jarOf([stored({ name: "theme", httpOnly: false })]);
    const capturing = captureCookies(api, "1", HOSTS, ["theme", "d_lax", "d_lax", "sid"]);
    await expect(capturing).rejects.toMatchObject({
      name: "CookiesNotReadable",
      message:
        'Chrome did not list the page\'s cookies "d_lax", "sid"; RECnRun needs host access to their domain.',
    });
  });

  test("counts only listed cookies the page could read: its host's or domain's, never HttpOnly", async () => {
    const api = jarOf([
      stored({ name: "dup", httpOnly: false }),
      stored({ name: "dup", path: "/deep", httpOnly: false }),
      stored({ name: "wide", domain: ".app.localhost", hostOnly: false, httpOnly: false }),
      stored({ name: "", httpOnly: false }),
      stored({ name: "sso", domain: "sso.localhost", httpOnly: false }),
      stored({ name: "secret" }),
    ]);
    await expect(
      captureCookies(api, "1", HOSTS, ["dup", "dup", "wide", ""]),
    ).resolves.toMatchObject({
      cookies: expect.any(Array),
    });
    for (const seen of [["dup", "dup", "dup"], ["sso"], ["secret"]]) {
      await expect(captureCookies(api, "1", HOSTS, seen), seen.join()).rejects.toMatchObject({
        name: "CookiesNotReadable",
      });
    }
  });
});
