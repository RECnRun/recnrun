import { expect, test } from "vite-plus/test";
import { buildAccess, skipsEntrypoint } from "@/config/permissions";

const POC = ["storage", "tabs", "declarativeNetRequest", "scripting", "cookies", "webNavigation"];

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
      host_permissions: ["http://*.localhost/*"],
      message_serialization: "structured_clone",
    });
  }
});

test("RECNRUN_POC_HOSTS adds each origin as a match pattern", () => {
  const access = buildAccess(
    "development",
    " https://zephyr-tq.one.be/app/ ,https://login-acc.one.be,",
  );
  expect(access.host_permissions).toEqual([
    "http://*.localhost/*",
    "https://zephyr-tq.one.be/*",
    "https://login-acc.one.be/*",
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
