import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSetCookie } from "./extension/jar.js";
import { buildRules } from "./extension/dnr-rules.js";

const NOW = Date.UTC(2026, 9, 25);
const cookie = (header, url = "http://app.localhost:4318/") => parseSetCookie(header, url, NOW);
const matches = (rule, url) => new RegExp(rule.condition.regexFilter).test(url);

const known = { knownTabIds: [] };

await test("every container tab loses Chrome's cookies and its Set-Cookie headers", () => {
  const [strip, remove] = buildRules([{ tabIds: [7, 8], jar: [] }], NOW, known);
  assert.deepEqual(strip.condition.tabIds, [7, 8]);
  assert.ok(
    strip.action.responseHeaders.some(
      ({ header, operation }) => header === "set-cookie" && operation === "remove",
    ),
  );
  assert.deepEqual(remove.condition.tabIds, [7, 8]);
  assert.deepEqual(remove.action.requestHeaders, [{ header: "cookie", operation: "remove" }]);
  assert.equal(remove.priority, 1);
});

await test("a tab no scan has classified yet gets no cookies and keeps none (default deny)", () => {
  const [deny, ...others] = buildRules([], NOW, { knownTabIds: [3, 4] }).filter(
    ({ condition }) => condition.excludedTabIds,
  );
  assert.equal(others.length, 0);
  assert.deepEqual(deny.condition.excludedTabIds, [3, 4, -1]);
  assert.deepEqual(deny.action.requestHeaders, [{ header: "cookie", operation: "remove" }]);
  assert.ok(deny.action.responseHeaders.some(({ header }) => header === "set-cookie"));
});

await test("no tab reads the shared HTTP cache, where container responses are stored by URL", () => {
  const rules = buildRules([{ tabIds: [7], jar: [] }], NOW, { knownTabIds: [7, 9] });
  const noCache = rules.find(({ action }) =>
    action.requestHeaders?.some(({ header }) => header === "cache-control"),
  );
  assert.deepEqual(noCache?.action.requestHeaders, [
    { header: "cache-control", operation: "set", value: "no-cache" },
  ]);
  assert.equal(noCache.condition.tabIds, undefined);
  assert.equal(noCache.condition.excludedTabIds, undefined);
});

await test("a container without tabs gets no rules of its own", () => {
  assert.deepEqual(buildRules([{ tabIds: [], jar: [cookie("a=1")] }], NOW, known).length, 2);
});

await test("a cookie scope gets first-party, cross-site navigation, and cross-site rules", () => {
  const jar = [cookie("sid=s1; SameSite=Lax"), cookie("n=1; SameSite=None; Secure")];
  const [, , first, navigation, cross] = buildRules([{ tabIds: [3], jar }], NOW, known);
  assert.equal(first.action.requestHeaders[0].value, "sid=s1; n=1");
  assert.equal(first.condition.domainType, "firstParty");
  assert.equal(navigation.action.requestHeaders[0].value, "sid=s1; n=1");
  assert.deepEqual(navigation.condition.resourceTypes, ["main_frame"]);
  assert.equal(cross.action.requestHeaders[0].value, "n=1");
  assert.ok(navigation.priority > cross.priority);
});

await test("host-only scopes match their host only; domain scopes match subdomains", () => {
  const jar = [cookie("h=1"), cookie("d=1; Domain=app.localhost")];
  const rules = buildRules([{ tabIds: [3], jar }], NOW, known).slice(2);
  const [hostOnly, domain] = [rules[0], rules[3]];
  assert.ok(matches(hostOnly, "http://app.localhost:4318/me"));
  assert.ok(!matches(hostOnly, "http://x.app.localhost/me"));
  assert.ok(matches(domain, "http://x.app.localhost/me"));
  assert.ok(!matches(domain, "http://evilapp.localhost/me"));
});

await test("longer paths win, and a path matches on a segment boundary", () => {
  const jar = [cookie("a=1"), cookie("b=2; Path=/api")];
  const rules = buildRules([{ tabIds: [3], jar }], NOW, known);
  const api = rules.find((rule) => rule.condition.regexFilter?.includes("api"));
  const root = rules.find((rule) => rule.condition.regexFilter?.endsWith(")?/"));
  assert.ok(api && root && api.priority > root.priority);
  assert.ok(
    matches(api, "http://app.localhost/api/me") && !matches(api, "http://app.localhost/apix"),
  );
  assert.equal(api.action.requestHeaders[0].value, "b=2; a=1");
});

await test("rule ids are unique across containers", () => {
  const rules = buildRules(
    [
      { tabIds: [1], jar: [cookie("a=1")] },
      { tabIds: [2], jar: [] },
    ],
    NOW,
    known,
  );
  assert.deepEqual(
    rules.map(({ id }) => id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

await test("N2 rules write the Cookie header of WebSocket handshakes only", () => {
  const options = { ...known, cookieTypes: ["websocket"] };
  const rules = buildRules([{ tabIds: [4], jar: [cookie("a=1")] }], NOW, options).slice(1, -2);
  assert.deepEqual(rules[0].condition.resourceTypes, ["websocket"]);
  const scoped = rules.slice(1);
  assert.ok(
    scoped.length > 0 &&
      scoped.every(({ condition }) => condition.resourceTypes.join() === "websocket"),
  );
  assert.equal(scoped[0].action.requestHeaders[0].value, "a=1");
  assert.ok(matches(scoped[0], "ws://app.localhost:4318/ws"));
});
