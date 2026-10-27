// Manual run of the lab extension against a real site, driven from the terminal:
//   vp run origin-snapshot-lab:manual -- <url>
// The tab's identity before the first switch is A. The person signs in by hand; every capture, clear, and restore runs in the extension. Output
// shows names, counts, and sizes only. Captures live in a temporary profile deleted on quit.
import { rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { cookieInventory, pageInventory } from "./inventory.mjs";
import { extensionCopy, launchLab, writeEvidence } from "./lab.mjs";

const HELP = `Commands:
  switch <identity>   suspend the tab's identity and start or resume <identity>
  reset <identity>    suspend the tab's identity and start <identity> empty
  inventory [label]   names, counts, and sizes of the origin's storage and cookies
  captures            the identities captured so far, by name and count
  help, quit`;

// vp run passes the `--` separator through.
const url = process.argv.slice(2).find((argument) => argument !== "--");
if (!url) throw new Error("Usage: vp run origin-snapshot-lab:manual -- <url>");
const { origin } = new URL(url);

/** The receipt of a switch without any stored value. */
const receipt = ({ from, to, kind, ms, report }) => ({
  from,
  to,
  kind,
  ms: Math.round(ms),
  cleared: report.cleared?.deleted,
  captureMs: Math.round(report.captureMs ?? 0),
  restoreMs: Math.round(report.restored ?? 0),
});

function sameOriginTabs({ context }, page) {
  return context.pages().filter((other) => other !== page && other.url().startsWith(origin));
}

async function switchTab(session, page, to, reset) {
  if (!to) return "name the identity";
  const others = sameOriginTabs(session, page);
  if (others.length > 0)
    return `refused: close the other tabs of ${origin} first (${others.length})`;
  if (!page.url().startsWith(origin)) return `refused: the tab must be on ${origin}`;
  const tabId = await session.lab.tabIdFor(page.url());
  return receipt(await session.lab.switchTo(tabId, to, { reset }));
}

async function inventory(session, page, label = "now") {
  const value = {
    page: await page.evaluate(pageInventory),
    cookies: await cookieInventory(session.context),
  };
  const file = writeEvidence(`manual-inventory-${label}`, value);
  return { file, ...value };
}

async function captures(session) {
  const names = await session.lab.captures();
  return Promise.all(
    names.map(async (name) => ({ name, ...(await session.lab.capture(origin, name)) })),
  );
}

function commands(session, page) {
  return {
    switch: (to) => switchTab(session, page, to, false),
    reset: (to) => switchTab(session, page, to, true),
    inventory: (label) => inventory(session, page, label),
    captures: () => captures(session),
    help: () => HELP,
  };
}

async function run(session, page) {
  const table = commands(session, page);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(HELP);
  for await (const line of terminal) {
    const [name, argument] = line.trim().split(/\s+/);
    if (name === "quit") break;
    const command = table[name];
    const result = command
      ? await Promise.resolve()
          .then(() => command(argument))
          .catch((error) => `failed: ${String(error?.message ?? error)}`)
      : `unknown command: ${name}`;
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }
  terminal.close();
}

const extension = extensionCopy((manifest) => ({ ...manifest, host_permissions: [`${origin}/*`] }));
const session = await launchLab({ extension, origin, bfcache: true });
try {
  await session.lab.configure({
    clear: { timeoutMs: 5000, probe: true },
    timeoutMs: 30000,
    firstIdentity: "A",
  });
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  await page.goto(url);
  await run(session, page);
} finally {
  await session.close();
  rmSync(extension, { recursive: true, force: true });
}
