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

const TARGET = "app.localhost";
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
    const cookies = await captureCookies(api, "1", TARGET, []);
    expect(api.all).toHaveBeenCalledExactlyOnceWith("1");
    expect(cookies).toEqual([
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
    const cookies = await captureCookies(
      jarOf([stored({ name: "shadow", path: "/deep" }), stored({ name: "shadow" })]),
      "1",
      TARGET,
      [],
    );
    expect(cookies.map(({ name, path }) => `${name}@${path}`)).toEqual([
      "shadow@/deep",
      "shadow@/",
    ]);
  });

  test("keeps every cookie of the store, whatever its host, host-only ones with their host", async () => {
    // The managed Incognito store holds only the open identity, so another site's cookies, such as
    // its sign-in provider's, are its data too.
    const cookies = await captureCookies(
      jarOf([
        stored({ name: "sso", domain: "sso.localhost" }),
        stored({ name: "wide", domain: ".localhost", hostOnly: false }),
        stored({ name: "parent", domain: ".sso.localhost", hostOnly: false }),
        stored({ name: "ads", domain: "other.localhost" }),
        stored({ name: "sub", domain: ".deep.app.localhost", hostOnly: false }),
        stored({ name: "kept" }),
      ]),
      "1",
      TARGET,
      [],
    );
    expect(cookies.map(({ name, domain, host }) => ({ name, domain, host }))).toEqual([
      { name: "sso", domain: undefined, host: "sso.localhost" },
      { name: "wide", domain: ".localhost", host: undefined },
      { name: "parent", domain: ".sso.localhost", host: undefined },
      { name: "ads", domain: undefined, host: "other.localhost" },
      { name: "sub", domain: ".deep.app.localhost", host: undefined },
      { name: "kept", domain: undefined, host: undefined },
    ]);
  });

  test("fails when the page shows a cookie Chrome did not list, naming it, never its value", async () => {
    // getAll leaves out a cookie of a site the user withheld from RECnRun (cookies_helpers.cc:51-56).
    const api = jarOf([stored({ name: "theme", httpOnly: false })]);
    const capturing = captureCookies(api, "1", TARGET, [
      { host: TARGET, names: ["theme", "d_lax", "d_lax", "sid"] },
    ]);
    await expect(capturing).rejects.toMatchObject({
      name: "CookiesNotReadable",
      message:
        'Chrome did not list the page\'s cookies "d_lax", "sid"; give RECnRun access to all sites in chrome://extensions.',
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
      captureCookies(api, "1", TARGET, [{ host: TARGET, names: ["dup", "dup", "wide", ""] }]),
    ).resolves.toHaveLength(6);
    for (const names of [["dup", "dup", "dup"], ["sso"], ["secret"]]) {
      const seen = [{ host: TARGET, names }];
      await expect(captureCookies(api, "1", TARGET, seen), names.join()).rejects.toMatchObject({
        name: "CookiesNotReadable",
      });
    }
  });

  test("checks each visited origin's page against its own host's cookies", async () => {
    const api = jarOf([
      stored({ name: "theme", httpOnly: false }),
      stored({ name: "sso", domain: "sso.localhost", httpOnly: false }),
    ]);
    const seen = [
      { host: TARGET, names: ["theme"] },
      { host: "sso.localhost", names: ["sso"] },
    ];
    await expect(captureCookies(api, "1", TARGET, seen)).resolves.toHaveLength(2);
    const lost = [...seen, { host: "other.localhost", names: ["sso", "gone"] }];
    await expect(captureCookies(api, "1", TARGET, lost)).rejects.toMatchObject({
      name: "CookiesNotReadable",
      message: expect.stringContaining('"sso", "gone"'),
    });
  });
});
