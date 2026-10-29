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

test("a production build asks only for storage and tabs", () => {
  expect(buildAccess("production")).toEqual({ permissions: ["storage", "tabs"] });
});

test("test and development builds add the POC set and access to every http(s) host", () => {
  // The whole Incognito store is the identity's; getAll drops a cookie whose domain the build
  // cannot reach as an http(s) URL without a port (cookies_helpers.cc:51-56, 201-206).
  for (const mode of ["test", "development"]) {
    expect(buildAccess(mode)).toEqual({
      permissions: POC,
      host_permissions: ["http://*/*", "https://*/*"],
      message_serialization: "structured_clone",
    });
  }
});

test("only a production build leaves the origin agent out", () => {
  expect(skipsEntrypoint("production", "origin-agent")).toBe(true);
  expect(skipsEntrypoint("test", "origin-agent")).toBe(false);
  expect(skipsEntrypoint("development", "origin-agent")).toBe(false);
  expect(skipsEntrypoint("production", "content")).toBe(false);
});
