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
    // tabs lets the dashboard list every tab, with its title and address, to record one.
    permissions: ["storage", "contextMenus", "tabs"],
    // No default_popup, so a toolbar click fires action.onClicked and records the tab.
    action: { default_title: "Record this tab with RECnRun" },
    commands: {
      "open-session": {
        suggested_key: { default: "Alt+Shift+S", mac: "MacCtrl+Shift+S" },
        description: "Record this tab with RECnRun",
      },
      "open-dashboard": {
        suggested_key: { default: "Alt+Shift+D", mac: "MacCtrl+Shift+D" },
        description: "Open a RECnRun dashboard",
      },
    },
    // Only the RECnRun site may frame these pages: the dashboard over it, the session in its PiP
    // window. Every other page gets ERR_BLOCKED_BY_CLIENT.
    web_accessible_resources: [
      {
        resources: ["dashboard.html", "session.html"],
        matches: contentScriptMatches(mode),
        use_dynamic_url: false,
      },
    ],
  }),
});
