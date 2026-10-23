import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";
import { contentScriptMatches } from "./src/config/origins.ts";

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
    permissions: ["storage"],
    // Only the RECnRun site may frame the dashboard; every other page gets ERR_BLOCKED_BY_CLIENT.
    // A dynamic URL would hide the stable id from the site, but the matches already scope it.
    web_accessible_resources: [
      {
        resources: ["dashboard.html"],
        matches: contentScriptMatches(mode),
        use_dynamic_url: false,
      },
    ],
  }),
});
