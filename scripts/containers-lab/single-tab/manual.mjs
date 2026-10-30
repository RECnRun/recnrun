// A manual run of the single-tab session manager: the fixture, a headed Chromium with the lab
// extension, and a prompt to switch identities in the one tab while you watch it. The mode comes
// from SINGLE_TAB_MODE ("swap" by default). Against a real site, --url and --domains give the
// extension that site's host permissions and prelude in a patched copy of its directory:
//   node scripts/containers-lab/single-tab/manual.mjs --url https://mail.google.com \
//     --domains google.com,youtube.com,googleusercontent.com,googleapis.com,gstatic.com
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { APP, startFixture } from "../fixture-server.mjs";
import { launchLab, readAfterReloads } from "../lab-browser.mjs";

const MODE = process.env.SINGLE_TAB_MODE ?? "swap";
const { values: options } = parseArgs({
  options: {
    url: { type: "string", default: `${APP}/home` },
    domains: { type: "string", default: "" },
    "cookies-only": { type: "boolean", default: false },
    "idle-ms": { type: "string", default: "5000" },
  },
});
const domains = options.domains.split(",").filter(Boolean);
const HELP = `Commands:
  A | B | C          switch to that identity (Start or Resume is decided for you)
  A /order?id=1      switch and open that path (or a full URL); the default is ${options.url}
  reset B            start B with a fresh session
  login Admin        sign the active identity in through the fixture's form
  show               the page's text (who the site shows)
  sessions | jar a | events | quit`;

/** A copy of the extension whose manifest also covers `domains`; without the prelude if asked. */
function patchedExtension() {
  const source = new URL("../extension", import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "recnrun-lab-extension-"));
  cpSync(source, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const patterns = domains.map((domain) => `*://*.${domain}/*`);
  manifest.host_permissions.push(...patterns);
  if (options["cookies-only"]) delete manifest.content_scripts;
  else manifest.content_scripts[0].matches.push(...patterns);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

const fixture = await startFixture();
const extension = domains.length > 0 ? patchedExtension() : undefined;
const handle = await launchLab({ headless: false, extension });
await handle.lab.setVariant("N2B1");
if (domains.length > 0) await handle.lab.setDomains(domains);
const opened = handle.context.waitForEvent("page", (page) => page.url().includes("manual"));
const tabId = await handle.lab.openTab(undefined, "manual");
const page = await opened;
await page.bringToFront();
console.log(`Mode ${MODE}, tab ${tabId}, app at ${APP}, domains ${domains.join(", ") || "lab"}.`);
console.log(HELP);

async function login(user) {
  await page.goto(`${APP}/login-form?user=${encodeURIComponent(user)}`);
  await page.click("button");
  return { signedInAs: await readAfterReloads(page, "**/home") };
}

function switchTo(first, rest) {
  const reset = first.toLowerCase() === "reset";
  const id = (reset ? rest.shift() : first).toUpperCase();
  const target = rest[0];
  const url = target === undefined ? options.url : /^https?:/.test(target) ? target : APP + target;
  const idleTimeoutMs = Number(options["idle-ms"]);
  return handle.lab.activate(tabId, id, { mode: MODE, reset, url, idleTimeoutMs });
}

async function run(line) {
  const [first, ...rest] = line.trim().split(/\s+/);
  const word = first.toLowerCase();
  if (word === "sessions") return handle.lab.sessions();
  if (word === "events") return (await handle.lab.events()).slice(-20);
  if (word === "jar") return handle.lab.jar(rest[0]);
  if (word === "login") return login(rest[0]);
  if (word === "help") return HELP;
  if (word === "show") return (await page.innerText("body")).slice(0, 600);
  return switchTo(first, rest);
}

const prompt = createInterface({ input: stdin, output: stdout });
for (;;) {
  const line = await prompt.question("> ");
  if (/^(q|quit|exit)$/i.test(line.trim())) break;
  if (line.trim() === "") continue;
  try {
    console.log(JSON.stringify(await run(line), null, 2));
  } catch (error) {
    console.error(String(error));
  }
}
prompt.close();
await handle.close();
await fixture.close();
if (extension) rmSync(extension, { recursive: true, force: true });
