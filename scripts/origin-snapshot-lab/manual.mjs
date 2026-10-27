// Manual run of the lab extension against a real site, driven from the terminal:
//   vp run origin-snapshot-lab:manual -- <url> [--with-host <host>]... [--incognito]
// Each --with-host (a sign-in server, say) has its cookies captured and swapped with the origin's.
// --incognito opens the URL in an incognito window, with "Allow in Incognito" turned on.
// The first tab opens in a "RECnRun · A" tab group; every tab of the origin must be in it, and
// a switch takes them all. The person signs in by hand; every capture, clear, and restore runs in
// the extension. Output shows names, counts, and sizes only. Captures live in a temporary profile
// deleted on quit.
import { rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { cookieInventory, pageInventory } from "./inventory.mjs";
import { extensionCopy, launchLab, openIncognito, writeEvidence } from "./lab.mjs";

const HELP = `Commands:
  switch <identity>   suspend the tab's identity and start or resume <identity>
  reset <identity>    suspend the tab's identity and start <identity> empty
  inventory [label]   names, counts, and sizes of the origin's storage and cookies
  captures            the identities captured so far, by name and count
  help, quit`;

const USAGE =
  "Usage: vp run origin-snapshot-lab:manual -- <url> [--with-host <host>]... [--incognito]";

/** The URL, the --with-host values, and --incognito; vp run passes the `--` separator through. */
function parseArguments(argv) {
  const cookieHosts = [];
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--with-host") cookieHosts.push(argv[(index += 1)]);
    else if (argv[index] !== "--" && argv[index] !== "--incognito") positional.push(argv[index]);
  }
  if (positional.length !== 1 || cookieHosts.some((host) => !/^[\w.-]+$/.test(host ?? ""))) {
    throw new Error(USAGE);
  }
  return { url: positional[0], cookieHosts, incognito: argv.includes("--incognito") };
}

const { url, cookieHosts, incognito } = parseArguments(process.argv.slice(2));
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

/** Leads from the group's tab on the origin; the extension refuses tabs of it outside the group. */
async function switchTab({ lab }, to, reset) {
  if (!to) return "name the identity";
  const lead = await lab.leadFor(origin, incognito);
  const { tabs, ...rest } = await lab.switchTo(lead, to, { reset });
  return { tabs, ...receipt(rest) };
}

async function inventory(session, label = "now") {
  const page = session.context.pages().find((open) => open.url().startsWith(`${origin}/`));
  if (!page) return `refused: no tab on ${origin}`;
  const value = {
    page: await page.evaluate(pageInventory),
    // Playwright sees only the normal window's cookies; the extension reads the incognito store.
    cookies: incognito
      ? await session.lab.cookieInventory(await session.lab.leadFor(origin, true))
      : await cookieInventory(session.context),
  };
  const file = writeEvidence(`manual-inventory-${label}`, value);
  return { file, ...value };
}

/** This run's partition only: the lab lists incognito captures as "<identity> (incognito)". */
async function captures(session) {
  const suffix = " (incognito)";
  const names = (await session.lab.captures()).filter(
    (name) => name.endsWith(suffix) === incognito,
  );
  const partition = incognito ? "incognito" : "normal";
  return Promise.all(
    names.map(async (name) => {
      const identity = incognito ? name.slice(0, -suffix.length) : name;
      return { name, ...(await session.lab.capture(origin, identity, partition)) };
    }),
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
          .catch((error) => `failed: ${String(error?.message ?? error).split("\n")[0]}`)
      : `unknown command: ${name}`;
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }
  terminal.close();
}

const extension = extensionCopy((manifest) => ({
  ...manifest,
  host_permissions: [`${origin}/*`, ...cookieHosts.map((host) => `*://${host}/*`)],
}));
const session = await launchLab({ extension, origin, bfcache: true, incognito });
try {
  await session.lab.configure({
    clear: { timeoutMs: 5000, probe: true },
    timeoutMs: 30000,
    firstIdentity: "A",
    cookieHosts,
  });
  console.log(`cookie hosts: ${cookieHosts.join(", ") || "none"}; incognito: ${incognito}`);
  if (incognito) {
    await session.lab.manage((await openIncognito(session, url)).tabId);
  } else {
    const page = session.context.pages()[0] ?? (await session.context.newPage());
    await session.lab.manage(await session.lab.activeTabId());
    await page.goto(url);
  }
  await run(session);
} finally {
  await session.close();
  rmSync(extension, { recursive: true, force: true });
}
