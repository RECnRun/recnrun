// A manual run of the single-tab session manager: the fixture, a headed Chromium with the lab
// extension, and a prompt to switch identities in the one tab while you watch it. The mode comes
// from SINGLE_TAB_MODE ("swap" by default). Usage: node scripts/containers-lab/single-tab/manual.mjs
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { APP, startFixture } from "../fixture-server.mjs";
import { launchLab, readAfterReloads } from "../lab-browser.mjs";

const MODE = process.env.SINGLE_TAB_MODE ?? "swap";
const HELP = `Commands:
  A | B | C          switch to that identity (Start or Resume is decided for you)
  A /order?id=1      switch and open that path (the first Start needs one; default /home)
  reset B            start B with a fresh session
  login Admin        sign the active identity in through the fixture's form
  sessions | jar a | events | quit`;

const fixture = await startFixture();
const handle = await launchLab({ headless: false });
await handle.lab.setVariant("N2B1");
const opened = handle.context.waitForEvent("page", (page) => page.url().includes("manual"));
const tabId = await handle.lab.openTab(undefined, "manual");
const page = await opened;
await page.bringToFront();
console.log(`Mode ${MODE}, tab ${tabId}, app at ${APP}.\n${HELP}`);

async function login(user) {
  await page.goto(`${APP}/login-form?user=${encodeURIComponent(user)}`);
  await page.click("button");
  return { signedInAs: await readAfterReloads(page, "**/home") };
}

function switchTo(first, rest) {
  const reset = first.toLowerCase() === "reset";
  const id = (reset ? rest.shift() : first).toUpperCase();
  const path = rest[0] ?? "/home";
  return handle.lab.activate(tabId, id, { mode: MODE, reset, url: `${APP}${path}` });
}

async function run(line) {
  const [first, ...rest] = line.trim().split(/\s+/);
  const word = first.toLowerCase();
  if (word === "sessions") return handle.lab.sessions();
  if (word === "events") return (await handle.lab.events()).slice(-20);
  if (word === "jar") return handle.lab.jar(rest[0]);
  if (word === "login") return login(rest[0]);
  if (word === "help") return HELP;
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
