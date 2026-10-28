import { afterEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  chromeHostPermissions,
  requireCookieHosts,
} from "@/background/workspace/cookie-host-access";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Host access to these patterns only, and every question asked. */
function granted(patterns: string[]) {
  const asked: string[][] = [];
  const contains = async (origins: string[]) => {
    asked.push(origins);
    return origins.every((origin) => patterns.includes(origin));
  };
  return { asked, permissions: { contains } };
}

const SSO = ["https://sso.example.com/*", "http://sso.example.com/*"];
const PARENT = ["https://example.com/*", "http://example.com/*"];

test("accepts a host when the build reaches it and each parent domain its cookies can name", async () => {
  const { asked, permissions } = granted([...SSO, ...PARENT]);
  await expect(requireCookieHosts(["sso.example.com"], permissions)).resolves.toBeUndefined();
  expect(asked).toEqual([[...SSO, ...PARENT]]);
});

test("refuses, naming them, the hosts whose cookies the build could not list or set", async () => {
  // Without the parent, a `.example.com` cookie would be left out of the capture silently.
  const { permissions } = granted(SSO);
  const refusal = requireCookieHosts(["sso.example.com", "login.other.org"], permissions);
  await expect(refusal).rejects.toMatchObject({
    name: "CookieHostNotAllowed",
    message: expect.stringContaining("sso.example.com, login.other.org"),
  });
});

test("asks nothing when the identity declares no host", async () => {
  const { asked, permissions } = granted([]);
  await requireCookieHosts([], permissions);
  expect(asked).toEqual([]);
});

test("asks Chrome's permissions API by default", async () => {
  const contains = vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true as never);
  await chromeHostPermissions.contains(SSO);
  expect(contains).toHaveBeenCalledWith({ origins: SSO });
});
