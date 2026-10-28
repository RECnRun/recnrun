// Opens a development build with host access to Zephyr's hosts in headed Chromium on a fresh
// profile, for the manual run in docs/poc-zephyr-runbook.md. It never opens a Zephyr page itself.
// Closing Chromium, or Ctrl+C, deletes the profile and with it every capture.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { prepareDevChrome } from "../apps/extension/scripts/dev-chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const ZEPHYR_HOSTS = "https://zephyr-tq.one.be,https://login-acc.one.be";
const hosts = process.env.RECNRUN_POC_HOSTS ?? ZEPHYR_HOSTS;
const SITE = "http://localhost:5173/";
const work = join(root, ".artifacts/poc-zephyr");
const extension = join(work, "extension");
const profile = join(work, "profile");

/** Runs `command` to completion with its output in the run's log, failing on a non-zero exit. */
function run(command, args, options) {
  const log = openSync(join(work, "build.log"), "a");
  const { status } = spawnSync(command, args, { ...options, stdio: ["ignore", log, log] });
  if (status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${status}; see build.log.`);
}

/** Builds the extension in development mode with access to `hosts`, into the run's folder. */
function build() {
  const app = join(root, "apps/extension");
  run(join(app, "node_modules/.bin/wxt"), ["build", "--mode", "development"], {
    cwd: app,
    env: { ...process.env, RECNRUN_POC_HOSTS: hosts },
  });
  cpSync(join(app, ".output/chrome-mv3-dev"), extension, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
  console.log(`Host access: ${manifest.host_permissions.join(" ")}`);
}

const siteUp = () =>
  fetch(SITE).then(
    (response) => response.ok,
    () => false,
  );

/** The website's dev server: an existing one, or one this run starts and stops. */
async function site() {
  if (await siteUp()) return undefined;
  const log = openSync(join(work, "website.log"), "a");
  const server = spawn("vp", ["run", "website#dev"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
  });
  for (let waited = 0; waited < 60_000; waited += 500) {
    if (await siteUp()) return server;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The website did not answer at ${SITE}; see website.log.`);
}

/** Headed Chromium with the build loaded, on chrome://extensions and the dashboard's site. */
async function open() {
  // Toggling "Allow in Incognito" reloads the extension, which Chromium disables as an unpacked
  // one while Developer mode is off.
  await prepareDevChrome(profile, { channel: "chromium" });
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers().at(0) ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  await (context.pages().at(0) ?? (await context.newPage())).goto(`chrome://extensions/?id=${id}`);
  await (await context.newPage()).goto(SITE);
  console.log(`RECnRun ${id} is loaded. Turn on "Allow in Incognito" on its details page,`);
  console.log("then follow docs/poc-zephyr-runbook.md. Close Chromium to end the run.");
  return context;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
let server;
let context;
const stop = () => context?.close();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  build();
  server = await site();
  context = await open();
  await new Promise((resolve) => context.on("close", resolve));
} finally {
  if (server?.pid !== undefined) process.kill(-server.pid);
  rmSync(work, { recursive: true, force: true });
  console.log("Deleted the run's profile, its captures, and the build.");
}
