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
    permissions: ["storage", "management", "debugger"],
  },
});
