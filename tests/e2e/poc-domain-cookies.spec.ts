import { SIBLINGS } from "./apps/cookie-pages.ts";
import { appLog } from "./fixtures/app.ts";
import { closeWorkspace } from "./fixtures/captures.ts";
import { incognitoJar, named } from "./fixtures/cookies.ts";
import { expect, test } from "./fixtures/extension.ts";
import { captureIdentity, startFromCapture, startWithIdentity } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const TARGET = `http://${SIBLINGS.target}:5192`;
const SSO = `http://${SIBLINGS.sso}:5192`;
const START = `${TARGET}/blank`;
const EMPTY = { cookies: [], site: { localStorage: {}, sessionStorage: {}, indexedDB: [] } };

/** The jar once both siblings answered: `Domain=localhost` is refused, a public suffix to Chrome. */
const KEPT = [
  "d_dot on .app.localhost/",
  "d_lax on .app.localhost/",
  "d_persist on .app.localhost/",
  "d_secure on .app.localhost/",
  "sso_domain on .app.localhost/",
  "sso_only on sso.app.localhost/",
  "www_only on www.app.localhost/",
];

/** Every cookie the sibling host must receive: the shared domain's, and its own host-only one. */
const SIBLING_COOKIES = ["d_dot", "d_lax", "d_persist", "d_secure", "sso_domain", "sso_only"];

test("a domain cookie comes back as a domain cookie and reaches the sibling host", async ({
  context,
  serviceWorker,
}) => {
  const run = `domain-${Date.now()}`;
  await startWithIdentity(serviceWorker, START, EMPTY);
  const source = await pageAt(context, START);
  // The sign-in host sets its cookies first, as an SSO redirect would, then the app sets its own.
  await source.goto(`${SSO}/domain-jar?run=${run}`);
  await source.goto(`${TARGET}/domain-jar?run=${run}`);
  await source.goto(START);
  const before = await incognitoJar(serviceWorker);
  const summary = await captureIdentity(serviceWorker, "identity-a");
  await closeWorkspace(serviceWorker, source);

  const timings = await startFromCapture(serviceWorker, "identity-a");
  const restored = await pageAt(context, START);
  const after = await incognitoJar(serviceWorker);
  const logged = (await appLog(run)).length;
  await restored.goto(`${SSO}/blank?run=${run}`);
  const ssoScript = await restored.evaluate(() =>
    document.cookie.split("; ").map((pair) => pair.split("=")[0] ?? ""),
  );
  const ssoRequests = (await appLog(run))
    .slice(logged)
    .filter(({ path, dest }) => path === "/blank" && dest === "document");
  await closeWorkspace(serviceWorker, restored);

  expect(named(before)).toEqual(KEPT);
  const shared = before.filter(({ domain }) => domain === ".app.localhost");
  expect(shared.every(({ hostOnly }) => !hostOnly)).toBe(true);
  // The whole Incognito store is the identity's, the sibling's host-only cookie too.
  expect(summary).toMatchObject({ cookies: KEPT.length, unsupported: 0 });
  expect(after).toEqual(before);
  expect(ssoRequests).toHaveLength(1);
  const sent = ssoRequests[0]?.cookies ?? [];
  expect(sent.toSorted((a, b) => a.localeCompare(b))).toEqual(SIBLING_COOKIES);
  expect(ssoScript.toSorted((a, b) => a.localeCompare(b))).toEqual([
    "d_lax",
    "d_persist",
    "d_secure",
  ]);

  await keep("domain-cookies", {
    summary,
    restoreTimings: timings,
    // Attributes only: a cookie's value never leaves the test.
    captured: before.map(({ value: _value, ...attributes }) => attributes),
    siblingRequestCookies: ssoRequests[0]?.cookies,
    siblingScriptCookies: ssoScript,
  });
});
