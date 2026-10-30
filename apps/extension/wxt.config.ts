import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";
import { EXTENSION_KEY } from "./src/config/key.ts";
import { externalMatches } from "./src/config/origins.ts";

export default defineConfig({
  srcDir: "src",
  // Explicit imports keep dependency-cruiser and Knip aware of every edge.
  imports: false,
  vite: () => ({ plugins: [preact()] }),
  webExt: {
    startUrls: ["http://localhost:5173/"],
    // A persistent profile keeps extension storage between dev runs; `vp run clean` resets it.
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
  },
  manifest: ({ mode }) => ({
    name: "RECnRun",
    description: "Records and replays browser sessions for developers.",
    key: EXTENSION_KEY,
    // Site access is optional and granted per origin at run time; see docs/ARCHITECTURE.md.
    permissions: ["storage", "scripting", "tabs", "tabGroups"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    externally_connectable: { matches: externalMatches(mode) },
  }),
});
