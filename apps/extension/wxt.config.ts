import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";
import { POC_PUBLIC_KEY } from "./scripts/poc-key.mjs";
import { debuggerDeclared, peersEnabled, pocEnabled } from "./src/config/origins.ts";

/** The cross-profile POC's page, left out of every build that has no cross-profile link. */
const PEER_ENTRYPOINTS = new Set(["offscreen"]);

/** The downloads-launcher POC pages, left out of every build but the POC variants. */
const POC_ENTRYPOINTS = new Set(["diagnostics"]);

const chromiumProfile = fileURLToPath(new URL("./.wxt/chrome-data", import.meta.url));

function permissions(mode: string): string[] {
  if (!peersEnabled(mode)) return ["storage", "tabs"];
  if (!pocEnabled(mode)) return ["storage", "tabs", "offscreen"];
  const base = ["storage", "tabs", "offscreen", "downloads"];
  return debuggerDeclared(mode) ? [...base, "debugger"] : base;
}

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
      const { mode } = wxt.config;
      const kept = entrypoints.filter(
        (entrypoint) =>
          (peersEnabled(mode) || !PEER_ENTRYPOINTS.has(entrypoint.name)) &&
          (pocEnabled(mode) || !POC_ENTRYPOINTS.has(entrypoint.name)),
      );
      entrypoints.splice(0, entrypoints.length, ...kept);
    },
  },
  manifest: ({ mode }) => ({
    // file:///* lets the POC pages fetch file:// once the owner allows file access (E1); never in production.
    ...(pocEnabled(mode) ? { key: POC_PUBLIC_KEY, host_permissions: ["file:///*"] } : {}),
    name: "RECnRun",
    description: "Records and replays browser sessions for developers.",
    // tabs lets the dashboard list every tab, with its title and address, to record one.
    // offscreen hosts the cross-profile POC's WebRTC link, in development and test builds only.
    permissions: permissions(mode),
    // One extension context spans normal and incognito windows, so the dashboard and the PiP
    // window see incognito tabs once the user turns on "Allow in Incognito".
    incognito: "spanning",
    // The toolbar icon has no popup: a click opens the dashboard, or brings the open one forward.
    action: { default_title: "RECnRun" },
  }),
});
