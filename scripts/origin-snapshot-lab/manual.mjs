// Manual run of the lab extension against a real site, driven from the terminal:
//   vp run origin-snapshot-lab:manual -- <url> [--with-host <host>]...
// Each --with-host (a sign-in server, say) has its cookies captured and swapped with the origin's.
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

/** The URL and the --with-host values; vp run passes the `--` separator through. */
function parseArguments(argv) {
  const cookieHosts = [];
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--with-host") cookieHosts.push(argv[(index += 1)]);
    else if (argv[index] !== "--") positional.push(argv[index]);
  }
  if (positional.length !== 1 || cookieHosts.some((host) => !/^[\w.-]+$/.test(host ?? ""))) {
    throw new Error("Usage: vp run origin-snapshot-lab:manual -- <url> [--with-host <host>]...");
  }
  return { url: positional[0], cookieHosts };
}

const { url, cookieHosts } = parseArguments(process.argv.slice(2));
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
  cookies: report.cookies,
});

/** Chrome's own list of the origin's tabs: a switch needs exactly one, and none on a cookie host. */
async function switchTab({ lab }, to, reset) {
  if (!to) return "name the identity";
  const tabs = await lab.originTabs(origin);
  if (tabs.length !== 1) {
    const paths = tabs.map((tab) => tab.path).join(", ");
    return `refused: needs exactly one tab on ${origin}, found ${tabs.length} ${paths}`;
  }
  for (const host of cookieHosts) {
    if ((await lab.hostTabs(host)).length > 0) return `refused: close the tabs on ${host} first`;
  }
  return receipt(await lab.switchTo(tabs[0].id, to, { reset }));
}

async function inventory(session, label = "now") {
  const page = session.context.pages().find((open) => open.url().startsWith(`${origin}/`));
  if (!page) return `refused: no tab on ${origin}`;
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

function commands(session) {
  return {
    switch: (to) => switchTab(session, to, false),
    reset: (to) => switchTab(session, to, true),
    inventory: (label) => inventory(session, label),
    captures: () => captures(session),
    help: () => HELP,
  };
}

async function run(session) {
  const table = commands(session);
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

const extension = extensionCopy((manifest) => ({
  ...manifest,
  host_permissions: [`${origin}/*`, ...cookieHosts.map((host) => `*://${host}/*`)],
}));
const session = await launchLab({ extension, origin, bfcache: true });
try {
  await session.lab.configure({
    clear: { timeoutMs: 5000, probe: true },
    timeoutMs: 30000,
    firstIdentity: "A",
    cookieHosts,
  });
  console.log(`cookie hosts: ${cookieHosts.join(", ") || "none"}`);
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  await page.goto(url);
  await run(session);
} finally {
  await session.close();
  rmSync(extension, { recursive: true, force: true });
}
