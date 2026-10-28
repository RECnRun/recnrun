import { FRAME_HOSTS } from "./apps/cookie-pages.ts";
import { appLog } from "./fixtures/app.ts";
import { BLANK, closeWorkspace, openBlank } from "./fixtures/captures.ts";
import { incognitoJar, named, setOutcomes } from "./fixtures/cookies.ts";
import { expect, test } from "./fixtures/extension.ts";
import { captureIdentity, startFromCapture } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const URL_ = `${APP}/`;
const SECURE = { url: URL_, secure: true, value: "x", path: "/" };
const IN_AN_HOUR = () => Date.now() / 1000 + 3600;

/** `cookies.set` calls as a restore could make, each with how Chrome answers it. */
const SET_CASES = {
  none_without_secure: { url: URL_, name: "t1", value: "x", sameSite: "no_restriction" },
  host_prefix_with_domain: { ...SECURE, name: "__Host-t2", domain: "app.localhost" },
  host_prefix_deep_path: { ...SECURE, name: "__Host-t3", path: "/deep" },
  host_prefix_insecure: { url: URL_, name: "__Host-t4", value: "x" },
  secure_prefix_insecure: { url: URL_, name: "__Secure-t5", value: "x" },
  partitioned_insecure: {
    url: URL_,
    name: "t6",
    value: "x",
    partitionKey: { topLevelSite: "http://app.localhost", hasCrossSiteAncestor: false },
  },
  cross_site_first_party_bit: {
    ...SECURE,
    url: "http://other.localhost:5192/",
    name: "t7",
    sameSite: "no_restriction",
    partitionKey: { topLevelSite: "http://app.localhost", hasCrossSiteAncestor: false },
  },
  expired: { url: URL_, name: "t8", value: "x", expirationDate: 1 },
  https_url_secure: { ...SECURE, url: "https://app.localhost:5192/", name: "t9" },
  host_prefix_ok: { ...SECURE, name: "__Host-t10" },
  persistent: { url: URL_, name: "t11", value: "x", expirationDate: IN_AN_HOUR() },
};

const REFUSED = (name: string) => `threw: Failed to parse or set cookie named "${name}".`;

/** What Chromium's sources predict for each case (cited in the POC checklist's S3.6 entry). */
const PREDICTED = {
  none_without_secure: REFUSED("t1"),
  host_prefix_with_domain: REFUSED("__Host-t2"),
  host_prefix_deep_path: REFUSED("__Host-t3"),
  host_prefix_insecure: REFUSED("__Host-t4"),
  secure_prefix_insecure: REFUSED("__Secure-t5"),
  partitioned_insecure: REFUSED("t6"),
  cross_site_first_party_bit:
    "threw: partitionKey has a first party value for hasCrossSiteAncestor when the url and the topLevelSite are not first party.",
  expired: "none",
  https_url_secure: "set",
  host_prefix_ok: "set",
  persistent: "set",
};

/** The jar as Chrome keeps it: frames keep only their partitioned cookie; refused ones are absent. */
const KEPT = [
  "d_domain on .app.localhost/",
  "frame_part on ads.localhost/",
  "__Host-pref on app.localhost/",
  "__Secure-pref on app.localhost/",
  "h_persist on app.localhost/",
  "h_session on app.localhost/",
  "none_secure on app.localhost/",
  "part_first on app.localhost/",
  "run on app.localhost/",
  "shadow on app.localhost/",
  "unspec on app.localhost/",
  "shadow on app.localhost/deep",
  "frame_part on other.localhost/",
];

test("the managed tab's cookies come back attribute for attribute, HttpOnly ones first", async ({
  context,
  serviceWorker,
}) => {
  const run = `cookies-${Date.now()}`;
  const source = await openBlank(context, serviceWorker);
  await source.goto(`${APP}/jar?run=${run}`);
  for (const host of Object.values(FRAME_HOSTS)) {
    await source.frameLocator(`iframe[title="${host}"]`).locator("p").waitFor();
  }
  const scriptVisible = await source.evaluate(() =>
    document.cookie.split("; ").map((pair) => pair.split("=")[0]),
  );
  await source.goto(BLANK);
  const before = await incognitoJar(serviceWorker);
  const summary = await captureIdentity(serviceWorker, "identity-a", [FRAME_HOSTS.declared]);
  await closeWorkspace(serviceWorker, source);

  const logged = (await appLog(run)).length;
  const timings = await startFromCapture(serviceWorker, "identity-a");
  const restored = await pageAt(context, BLANK);
  const documents = (await appLog(run)).slice(logged).filter(({ dest }) => dest === "document");
  const [first, reloaded] = documents;
  const after = await incognitoJar(serviceWorker);
  const outcomes = await setOutcomes(serviceWorker, SET_CASES);
  await closeWorkspace(serviceWorker, restored);

  expect(named(before)).toEqual(KEPT);
  expect(outcomes).toEqual(PREDICTED);
  const undeclared = before.filter(({ domain }) => domain === FRAME_HOSTS.undeclared);
  expect(undeclared.map(({ name }) => name)).toEqual(["frame_part"]);
  expect(summary).toMatchObject({ cookies: before.length - 1, unsupported: 1 });
  expect(after).toEqual(before.filter(({ domain }) => domain !== FRAME_HOSTS.undeclared));
  expect(first).toMatchObject({ path: "/blank", dest: "document" });
  expect(first?.cookies).toEqual(expect.arrayContaining(["h_session", "run"]));
  // The barrier's navigation has the extension as initiator, and its reload inherits it, so
  // neither document request carries the restored SameSite=Strict cookie, though the jar holds it.
  expect(first?.cookies).not.toContain("h_persist");
  expect(reloaded).toMatchObject({ path: "/blank", dest: "document", cookies: first?.cookies });

  await keep("capture-cookies", {
    summary,
    restoreTimings: timings,
    scriptVisible,
    // Attributes only: a cookie's value never leaves the test.
    captured: before.map(({ value: _value, ...attributes }) => attributes),
    firstRequestCookies: first?.cookies,
    reloadRequestCookies: reloaded?.cookies,
    setOutcomes: outcomes,
  });
});
