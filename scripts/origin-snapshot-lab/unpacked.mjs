// The lab extension for the person's own Chrome (Experiment G):
//   vp run origin-snapshot-lab:unpacked -- <url> [--with-host <host>]... [--force-clear]
// Writes .artifacts/origin-snapshot-lab/unpacked with host access to the URL's origin and each
// cookie host (subdomains included), and a preset.json the worker applies whenever it starts.
// Load it at chrome://extensions ("Load unpacked") and drive it from its dashboard (toolbar button).
import { parseSite, writeUnpacked } from "./lab.mjs";

const USAGE =
  "Usage: vp run origin-snapshot-lab:unpacked -- <url> [--with-host <host>]... [--force-clear]";
const site = parseSite(process.argv.slice(2), USAGE);
const dir = writeUnpacked(site);
console.log(`Load unpacked: ${dir}`);
console.log(
  `Origin: ${new URL(site.url).origin}; cookie hosts: ${site.cookieHosts.join(", ") || "none"}`,
);
if (site.forceClear)
  console.log("Each switch force-clears IndexedDB and removes the service worker");
console.log("Then click the lab's toolbar button: its dashboard opens in a tab");
