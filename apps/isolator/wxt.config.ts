import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  // Explicit imports keep dependency-cruiser and Knip aware of every edge.
  imports: false,
  webExt: {
    // A persistent profile keeps extension storage between dev runs; `vp run clean` resets it.
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
  },
  manifest: {
    name: "RECnRun Isolator (POC)",
    description: "Namespaced sessions proof of concept.",
    // E0 needs storage and management; E1 adds debugger, which needs no host permission (PLAN.md P0.3, P0.4).
    // E7 adds scripting for Route C's MAIN-world page bootstrap (PLAN.md P1.6).
    permissions: ["storage", "management", "debugger", "scripting"],
    // Route C injects on the app origins, and on loopback frames and popups only when E7 names them (no SSO host here, R5).
    host_permissions: [
      "http://app.localhost:4600/*",
      "http://app.localhost:4603/*",
      "http://*.localhost/*",
    ],
    // Route C's worker wrappers import the slot and the bootstrap from the app origins.
    web_accessible_resources: [
      {
        resources: ["route-c.js", "ns/*.js"],
        matches: ["http://app.localhost:4600/*", "http://app.localhost:4603/*"],
      },
    ],
  },
});
