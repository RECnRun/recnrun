import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieHeader, parseSetCookie, siteOf, storeCookie } from "./extension/jar.js";

const NOW = Date.UTC(2026, 9, 25);
const APP = "http://app.localhost:4318/login";

function jarWith(...headers) {
  return headers.reduce(
    (jar, header) => storeCookie(jar, parseSetCookie(header, APP, NOW), NOW),
    [],
  );
}

await test("a host-only cookie reaches its host and no other", () => {
  const jar = jarWith("sid=a1; Path=/; HttpOnly");
  assert.equal(cookieHeader(jar, "http://app.localhost:4318/me", { now: NOW }), "sid=a1");
  assert.equal(cookieHeader(jar, "http://sub.app.localhost:4318/me", { now: NOW }), "");
  assert.equal(cookieHeader(jar, "http://idp.localhost:4319/me", { now: NOW }), "");
});

await test("a domain cookie reaches subdomains, and a foreign domain is rejected", () => {
  const jar = jarWith("d=1; Domain=app.localhost; Path=/");
  assert.equal(cookieHeader(jar, "http://sub.app.localhost/x", { now: NOW }), "d=1");
  assert.equal(parseSetCookie("x=1; Domain=idp.localhost", APP, NOW), undefined);
});

await test("paths match by prefix on a segment boundary and the default path is the directory", () => {
  const jar = jarWith("a=1; Path=/api", "b=2");
  assert.equal(cookieHeader(jar, "http://app.localhost:4318/api/me", { now: NOW }), "a=1; b=2");
  assert.equal(cookieHeader(jar, "http://app.localhost:4318/apix", { now: NOW }), "b=2");
  assert.equal(parseSetCookie("c=3", "http://app.localhost/a/b/page", NOW)?.path, "/a/b");
});

await test("longer paths come first, and a later cookie replaces one with the same key", () => {
  const jar = jarWith("a=1; Path=/", "a=2; Path=/api", "a=3; Path=/");
  assert.equal(cookieHeader(jar, "http://app.localhost:4318/api/x", { now: NOW }), "a=2; a=3");
});

await test("expiry: Max-Age wins over Expires, and an expired cookie deletes the stored one", () => {
  const future = new Date(NOW + 86_400_000).toUTCString();
  const kept = jarWith(`a=1; Expires=${future}; Max-Age=60`);
  assert.equal(kept[0]?.expires, NOW + 60_000);
  const removed = storeCookie(kept, parseSetCookie("a=; Max-Age=0", APP, NOW), NOW);
  assert.deepEqual(removed, []);
  assert.equal(cookieHeader(kept, APP, { now: NOW + 61_000 }), "");
});

await test("SameSite: cross-site requests carry None cookies, and Lax ones on top-level GET", () => {
  const jar = jarWith("n=1; SameSite=None; Secure", "l=2; SameSite=Lax", "s=3; SameSite=Strict");
  const url = "http://app.localhost:4318/me";
  assert.equal(cookieHeader(jar, url, { now: NOW, crossSite: true }), "n=1");
  const navigation = { now: NOW, crossSite: true, topLevelNavigation: true, method: "GET" };
  assert.equal(cookieHeader(jar, url, navigation), "n=1; l=2");
  assert.equal(cookieHeader(jar, url, { ...navigation, method: "POST" }), "n=1");
  assert.equal(cookieHeader(jar, url, { now: NOW }), "n=1; l=2; s=3");
});

await test("Secure cookies need https or a localhost host", () => {
  const jar = storeCookie([], parseSetCookie("s=1; Secure", "https://example.com/", NOW), NOW);
  assert.equal(cookieHeader(jar, "http://example.com/", { now: NOW }), "");
  assert.equal(cookieHeader(jar, "https://example.com/", { now: NOW }), "s=1");
  assert.equal(parseSetCookie("s=1; Secure", "http://example.com/", NOW), undefined);
  assert.ok(parseSetCookie("s=1; Secure", APP, NOW));
});

await test("the __Host- and __Secure- prefixes enforce their rules", () => {
  assert.ok(parseSetCookie("__Host-a=1; Secure; Path=/", APP, NOW));
  assert.equal(parseSetCookie("__Host-a=1; Secure; Path=/x", APP, NOW), undefined);
  assert.equal(
    parseSetCookie("__Host-a=1; Secure; Path=/; Domain=app.localhost", APP, NOW),
    undefined,
  );
  assert.equal(parseSetCookie("__Secure-a=1", APP, NOW), undefined);
});

await test("partitioned cookies reach only the top-level site that set them", () => {
  const cookie = parseSetCookie("p=1; Secure; Partitioned; SameSite=None", APP, NOW, {
    topSite: "http://shop.localhost",
  });
  const jar = storeCookie([], cookie, NOW);
  const options = { now: NOW, crossSite: true };
  assert.equal(cookieHeader(jar, APP, { ...options, topSite: "http://shop.localhost" }), "p=1");
  assert.equal(cookieHeader(jar, APP, { ...options, topSite: "http://other.localhost" }), "");
});

await test("script cannot write an HttpOnly cookie or replace one", () => {
  const jar = jarWith("sid=a1; HttpOnly");
  const fromScript = parseSetCookie("sid=evil", APP, NOW, { fromScript: true });
  assert.deepEqual(storeCookie(jar, fromScript, NOW), jar);
  assert.equal(parseSetCookie("x=1; HttpOnly", APP, NOW, { fromScript: true }), undefined);
});

await test("sites are scheme and the last two host labels", () => {
  assert.equal(siteOf("http://app.localhost:4318/x"), "http://app.localhost");
  assert.equal(siteOf("https://a.b.example.com/"), "https://example.com");
});
