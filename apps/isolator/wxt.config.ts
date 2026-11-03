import { defineConfig } from "wxt";
import {
  MODULE_BOOTSTRAP_PATH,
  renderModuleResource,
} from "./src/background/route-b/module-resource.ts";

export default defineConfig({
  srcDir: "src",
  // Explicit imports keep dependency-cruiser and Knip aware of every edge.
  imports: false,
  webExt: {
    // A persistent profile keeps extension storage between dev runs; `vp run clean` resets it.
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
  },
  hooks: {
    // Route B (E5) imports the bootstrap as a module; dist/ exists at build time, not at prepare.
    "build:publicAssets": async (_wxt, files) => {
      const { BOOTSTRAP_SOURCE } = await import("@recnrun/worker-bootstrap");
      const contents = renderModuleResource(BOOTSTRAP_SOURCE);
      files.push({ relativeDest: MODULE_BOOTSTRAP_PATH, contents });
    },
  },
  manifest: {
    name: "RECnRun Isolator (POC)",
    description: "Namespaced sessions proof of concept.",
    // E0 needs storage and management; E1 adds debugger, which needs no host permission (PLAN.md P0.3, P0.4).
    // E7 adds scripting for Route C's MAIN-world page bootstrap (PLAN.md P1.6); E4 adds declarativeNetRequest to block
    // the fixture apps' service-worker scripts and close their tabs, on the loopback only (P1.3).
    permissions: ["storage", "management", "debugger", "scripting", "declarativeNetRequest"],
    // Route C injects on the app origins, and on loopback frames and popups only when E7 names them (no SSO host here, R5).
    host_permissions: [
      "http://app.localhost:4600/*",
      "http://app.localhost:4603/*",
      "http://*.localhost/*",
    ],
    web_accessible_resources: [
      // Route C's worker wrappers import the slot and the bootstrap from the app origins.
      {
        resources: ["route-c.js", "ns/*.js"],
        matches: ["http://app.localhost:4600/*", "http://app.localhost:4603/*"],
      },
      // Route B (E5): a module service worker on a loopback origin imports the bootstrap from here.
      {
        resources: [MODULE_BOOTSTRAP_PATH],
        matches: ["http://*.localhost/*", "http://localhost/*", "http://127.0.0.1/*"],
      },
    ],
  },
});
