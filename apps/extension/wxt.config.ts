import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";
import { contentScriptMatches } from "./src/config/origins.ts";

const chromiumProfile = fileURLToPath(new URL("./.wxt/chrome-data", import.meta.url));

export default defineConfig({
  srcDir: "src",
  // Explicit imports keep dependency-cruiser and Knip aware of every edge.
  imports: false,
  vite: () => ({ plugins: [preact()] }),
  webExt: {
    startUrls: ["http://localhost:5173/"],
    // A persistent profile keeps extension storage between dev runs; `vp run clean` resets it.
    chromiumProfile,
    keepProfileChanges: true,
  },
  hooks: {
    "server:started": async () => {
      // Chrome protects this preference on macOS and Windows; let Chrome save it itself.
      const { prepareDevChrome } = await import("../../scripts/dev-chrome.ts");
      await prepareDevChrome(chromiumProfile);
    },
  },
  manifest: ({ mode }) => ({
    name: "RECnRun",
    description: "Records and replays browser sessions for developers.",
    // tabs lets the dashboard list every tab, with its title and address, to record one.
    permissions: ["storage", "tabs"],
    // One extension context spans normal and incognito windows, so the dashboard and the PiP
    // window see incognito tabs once the user turns on "Allow in Incognito".
    incognito: "spanning",
    // The toolbar icon has no popup and no listener, so a click does nothing: the site is the way in.
    action: { default_title: "RECnRun" },
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
