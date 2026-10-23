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
    // activeTab reveals the URL of the tab a trigger came from, to split it with its workspace.
    permissions: ["storage", "contextMenus", "activeTab"],
    // No default_popup, so a toolbar click fires action.onClicked and opens the dashboard.
    action: { default_title: "Open the RECnRun dashboard" },
    commands: {
      "open-dashboard": {
        suggested_key: { default: "Alt+Shift+D", mac: "MacCtrl+Shift+D" },
        description: "Open the RECnRun dashboard",
      },
    },
    // Only the RECnRun site may frame the dashboard; every other page gets ERR_BLOCKED_BY_CLIENT.
    web_accessible_resources: [
      {
        resources: ["dashboard.html"],
        matches: contentScriptMatches(mode),
        use_dynamic_url: false,
      },
    ],
  }),
});
