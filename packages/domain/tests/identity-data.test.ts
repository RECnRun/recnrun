import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { IdentityDataSchema, SiteCookieSchema, WorkspaceOperationSchema } from "../src/index.ts";
import type { IdentityData, SiteCookie } from "../src/index.ts";

const session: SiteCookie = {
  name: "sid",
  value: "abc",
  path: "/",
  secure: false,
  httpOnly: true,
  sameSite: "strict",
};
const lasting: SiteCookie = {
  ...session,
  name: "theme",
  domain: "app.localhost",
  httpOnly: false,
  sameSite: "lax",
  expirationDate: 4_102_444_800,
};
const identity: IdentityData = {
  cookies: [session, lasting],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [] },
};

test("accepts host-only, domain, session, and lasting cookies with every attribute", () => {
  expect(v.parse(IdentityDataSchema, identity)).toEqual(identity);
  expect(
    v.parse(SiteCookieSchema, { ...session, sameSite: "no_restriction", secure: true }),
  ).toEqual({ ...session, sameSite: "no_restriction", secure: true });
});

test("keeps a partitioned cookie's partition key", () => {
  const partitioned = {
    ...session,
    secure: true,
    sameSite: "no_restriction" as const,
    partitionKey: { topLevelSite: "http://app.localhost", hasCrossSiteAncestor: false },
  };
  expect(v.parse(SiteCookieSchema, partitioned)).toEqual(partitioned);
  expect(v.is(SiteCookieSchema, { ...partitioned, partitionKey: { topLevelSite: 1 } })).toBe(false);
});

test("rejects a cookie without a path from the root, a known SameSite, or a numeric expiry", () => {
  for (const cookie of [
    { ...session, path: "app" },
    { ...session, sameSite: "none" },
    { ...session, expirationDate: "tomorrow" },
    { ...session, httpOnly: undefined },
    { ...session, value: 1 },
  ]) {
    expect(v.is(SiteCookieSchema, cookie), JSON.stringify(cookie)).toBe(false);
  }
});

test("rejects identity data without its cookies or its site data", () => {
  expect(v.is(IdentityDataSchema, { site: identity.site })).toBe(false);
  expect(v.is(IdentityDataSchema, { cookies: [] })).toBe(false);
  expect(v.is(IdentityDataSchema, { ...identity, site: { localStorage: {} } })).toBe(false);
});

const running = {
  id: "op-1",
  kind: "start-with-identity",
  step: "restore",
  status: "running",
  started: 1_000,
  generation: 2,
  windowId: 5,
};

test("accepts a running operation and a failed one with its error", () => {
  expect(v.parse(WorkspaceOperationSchema, running)).toEqual(running);
  const failed = { ...running, status: "failed", error: "The page closed." };
  expect(v.parse(WorkspaceOperationSchema, failed)).toEqual(failed);
  const early = {
    id: "op-2",
    kind: "start-with-identity",
    step: "window",
    status: "done",
    started: 1,
  };
  expect(v.parse(WorkspaceOperationSchema, early)).toEqual(early);
});

test("rejects an operation of an unknown kind or status, or without an id or a step", () => {
  for (const operation of [
    { ...running, kind: "switch" },
    { ...running, status: "paused" },
    { ...running, id: "" },
    { ...running, step: undefined },
    { ...running, generation: -1 },
  ]) {
    expect(v.is(WorkspaceOperationSchema, operation), JSON.stringify(operation)).toBe(false);
  }
});
