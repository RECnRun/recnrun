import { beforeAll, expect, test } from "vite-plus/test";
import { PORT_OFFER_EVENT } from "@/messaging/response-url-protocol";
import { receiveUrls, startResponseUrlPage } from "@/origin/response-url-page";
import { acceptPort } from "@/origin/response-url-relay";

const at = (path: string) => new URL(path, location.origin).href;
const SHOWN = "https://app.example/a?via=redirect";

const PATCHED = [
  [Cache.prototype, "match"],
  [Cache.prototype, "matchAll"],
  [CacheStorage.prototype, "match"],
  [Response.prototype, "clone"],
] as const;

/** The functions themselves, read off their descriptors so none is called unbound. */
const functions = () =>
  PATCHED.map(
    ([proto, key]) =>
      Object.getOwnPropertyDescriptor(proto, key)?.value as (...args: never[]) => unknown,
  );
const natives = functions();

// The relay answers as the background would for this origin, then the page script patches.
beforeAll(async () => {
  await caches.delete("pages");
  const cache = await caches.open("pages");
  await cache.put(at("/a"), new Response("a"));
  await cache.put(at("/b"), new Response("b"));
  acceptPort(document, (port) => port.postMessage([[at("/a"), SHOWN]]));
  startResponseUrlPage();
});

test("shows a restored entry's URL through every lookup, and on its clones", async () => {
  const cache = await caches.open("pages");
  const matched = await cache.match("/a");
  expect(matched?.url).toBe(SHOWN);
  expect(matched?.clone().url).toBe(SHOWN);
  expect((await cache.matchAll()).map(({ url }) => url)).toEqual([SHOWN, ""]);
  expect((await cache.matchAll("/a")).map(({ url }) => url)).toEqual([SHOWN]);
  expect((await caches.match("/a"))?.url).toBe(SHOWN);
  expect((await caches.match("/a", { cacheName: "pages" }))?.url).toBe(SHOWN);
});

test("leaves an entry the relay did not name, a miss, and a fetched response as they are", async () => {
  const cache = await caches.open("pages");
  expect((await cache.match("/b"))?.url).toBe("");
  expect(await cache.match("/none")).toBeUndefined();
  expect(await caches.match("/none")).toBeUndefined();
  expect(await caches.match("/a", { cacheName: "missing" })).toBeUndefined();
  const fetched = await fetch(location.href);
  expect(fetched.url).toBe(location.href);
  await cache.put(at("/fetched"), fetched);
  expect((await cache.match("/fetched"))?.url).toBe(location.href);
  await cache.delete(at("/fetched"));
  expect(new Response("built").url).toBe("");
});

test("keeps each patched function's name and length", () => {
  const patched = functions();
  natives.forEach((native, index) => {
    const now = patched[index];
    expect(now, native.name).not.toBe(native);
    expect([now?.name, now?.length], native.name).toEqual([native.name, native.length]);
  });
  const url = Object.getOwnPropertyDescriptor(Response.prototype, "url");
  expect(url).toMatchObject({ enumerable: true, configurable: true, set: undefined });
});

test("hears nothing without a relay, or from one that sends something else", async () => {
  expect([...(await receiveUrls(new EventTarget(), 10))]).toEqual([]);
  const target = new EventTarget();
  target.addEventListener(PORT_OFFER_EVENT, (event) => {
    event.preventDefault();
    (event as MessageEvent).ports[0]?.postMessage({ not: "pairs" });
  });
  expect([...(await receiveUrls(target, 1_000))]).toEqual([]);
});
