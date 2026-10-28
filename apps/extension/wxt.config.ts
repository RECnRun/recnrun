import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";
import { peersEnabled } from "./src/config/origins.ts";

/** The cross-profile POC's pages, left out of every build that has no cross-profile link. */
const PEER_ENTRYPOINTS = new Set(["offscreen", "folder"]);

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
      const { prepareDevChrome } = await import("./scripts/dev-chrome.ts");
      await prepareDevChrome(chromiumProfile);
    },
    "entrypoints:resolved": (wxt, entrypoints) => {
      if (peersEnabled(wxt.config.mode)) return;
      const kept = entrypoints.filter((entrypoint) => !PEER_ENTRYPOINTS.has(entrypoint.name));
      entrypoints.splice(0, entrypoints.length, ...kept);
    },
  },
  manifest: ({ mode }) => ({
    name: "RECnRun",
    description: "Records and replays browser sessions for developers.",
    // tabs lets the dashboard list every tab, with its title and address, to record one.
    // offscreen hosts the cross-profile POC's WebRTC link, in development and test builds only.
    permissions: peersEnabled(mode) ? ["storage", "tabs", "offscreen"] : ["storage", "tabs"],
    // One extension context spans normal and incognito windows, so the dashboard and the PiP
    // window see incognito tabs once the user turns on "Allow in Incognito".
    incognito: "spanning",
    // The toolbar icon has no popup: a click opens the dashboard, or brings the open one forward.
    action: { default_title: "RECnRun" },
  }),
});
