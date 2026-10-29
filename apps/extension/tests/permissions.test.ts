import { expect, test } from "vite-plus/test";
import { MANIFEST_ACCESS } from "@/config/permissions";

test("every build asks for the recorder's and the workspace's permissions and every http(s) host", () => {
  // The whole Incognito store is the identity's; getAll drops a cookie whose domain the build
  // cannot reach as an http(s) URL without a port (cookies_helpers.cc:51-56, 201-206).
  expect(MANIFEST_ACCESS).toEqual({
    permissions: [
      "storage",
      "tabs",
      "declarativeNetRequest",
      "scripting",
      "cookies",
      "webNavigation",
      "unlimitedStorage",
    ],
    host_permissions: ["http://*/*", "https://*/*"],
    message_serialization: "structured_clone",
  });
});
