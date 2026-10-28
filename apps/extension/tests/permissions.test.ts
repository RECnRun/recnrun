import { expect, test } from "vite-plus/test";
import { buildAccess, skipsEntrypoint } from "@/config/permissions";

const POC = [
  "storage",
  "tabs",
  "declarativeNetRequest",
  "scripting",
  "cookies",
  "webNavigation",
  "unlimitedStorage",
];

test("a production build asks only for storage and tabs, whatever hosts are passed", () => {
  expect(buildAccess("production")).toEqual({ permissions: ["storage", "tabs"] });
  expect(buildAccess("production", "https://zephyr-tq.one.be")).toEqual({
    permissions: ["storage", "tabs"],
  });
});

test("test and development builds add the POC set and the fixture hosts", () => {
  for (const mode of ["test", "development"]) {
    expect(buildAccess(mode)).toEqual({
      permissions: POC,
      // Chrome lists a Secure cookie only with access to its https URL, even on http localhost.
      host_permissions: ["http://*.localhost/*", "https://*.localhost/*"],
      message_serialization: "structured_clone",
    });
  }
});

test("RECNRUN_POC_HOSTS adds each host and every parent domain a cookie of it can name", () => {
  // getAll and set need access to the cookie's domain as a URL, its scheme from Secure alone
  // (cookies_helpers.cc:51-56, 201-206; cookie_util.cc:664-692): https://one.be/ for a Secure
  // `.one.be` cookie, http://one.be/ for one without Secure, whatever the site's own scheme.
  const access = buildAccess(
    "development",
    " https://zephyr-tq.one.be/app/ ,https://login-acc.one.be:8443,",
  );
  expect(access.host_permissions).toEqual([
    "http://*.localhost/*",
    "https://*.localhost/*",
    "https://zephyr-tq.one.be/*",
    "http://zephyr-tq.one.be/*",
    "https://one.be/*",
    "http://one.be/*",
    "https://login-acc.one.be/*",
    "http://login-acc.one.be/*",
  ]);
});

test("RECNRUN_POC_HOSTS adds no parent for a single-label host or an IP address", () => {
  const access = buildAccess(
    "development",
    "http://intranet:8080,http://10.0.0.7,http://[::1]:3000",
  );
  expect(access.host_permissions?.slice(2)).toEqual([
    "https://intranet/*",
    "http://intranet/*",
    "https://10.0.0.7/*",
    "http://10.0.0.7/*",
    "https://[::1]/*",
    "http://[::1]/*",
  ]);
});

test("RECNRUN_POC_HOSTS refuses anything but an http(s) origin", () => {
  expect(() => buildAccess("development", "zephyr-tq.one.be")).toThrow(/not an http\(s\) origin/);
  expect(() => buildAccess("development", "chrome://extensions")).toThrow(/chrome:\/\/extensions/);
});

test("only a production build leaves the origin agent out", () => {
  expect(skipsEntrypoint("production", "origin-agent")).toBe(true);
  expect(skipsEntrypoint("test", "origin-agent")).toBe(false);
  expect(skipsEntrypoint("development", "origin-agent")).toBe(false);
  expect(skipsEntrypoint("production", "content")).toBe(false);
});
