import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

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
  manifest: {
    name: "RECnRun",
    description: "Records and replays browser sessions for developers.",
    permissions: ["storage", "contextMenus"],
    // No default_popup, so a toolbar click fires action.onClicked and opens the dashboard.
    action: { default_title: "Open the RECnRun dashboard" },
    // Typing "rr" then Space or Tab in the address bar hands the input to the omnibox listeners.
    omnibox: { keyword: "rr" },
    commands: {
      "open-dashboard": {
        suggested_key: { default: "Alt+Shift+D", mac: "MacCtrl+Shift+D" },
        description: "Open the RECnRun dashboard",
      },
    },
  },
});
