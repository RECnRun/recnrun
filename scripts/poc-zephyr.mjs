// Opens a development build with host access to Zephyr's hosts in headed Chromium on a fresh
// profile, for the manual run in docs/poc-zephyr-runbook.md. It never opens a Zephyr page itself.
// Closing Chromium, or Ctrl+C, deletes the profile and with it every capture.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { prepareDevChrome } from "../apps/extension/scripts/dev-chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const ZEPHYR_HOSTS = "https://zephyr-tq.one.be,https://login-acc.one.be";
const hosts = process.env.RECNRUN_POC_HOSTS ?? ZEPHYR_HOSTS;
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

const answers = (url) =>
  fetch(url).then(
    (response) => response.ok,
    () => false,
  );

/** A port nothing listens on now, for this run's own website. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "localhost", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** This run's website, a process group of its own. */
let server;

/**
 * Builds this checkout's website and serves it on a free port. Another checkout's dev server may
 * hold 5173, and its site may not match this build; content scripts match localhost on any port.
 */
async function site() {
  run("vp", ["run", "--no-cache", "website#build"], { cwd: root });
  const port = String(await freePort());
  const log = openSync(join(work, "website.log"), "a");
  const args = [
    "run",
    "website#preview",
    "--",
    "--port",
    port,
    "--strictPort",
    "--host",
    "localhost",
  ];
  server = spawn("vp", args, { cwd: root, detached: true, stdio: ["ignore", log, log] });
  const url = `http://localhost:${port}/`;
  for (let waited = 0; waited < 60_000 && server.exitCode === null; waited += 500) {
    if (await answers(url)) return url;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`This checkout's website did not answer at ${url}; see website.log.`);
}

/** Headed Chromium with the build loaded, on chrome://extensions and the site at `url`. */
async function open(url) {
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
  await (await context.newPage()).goto(url);
  console.log(`This checkout's website is at ${url}.`);
  console.log(`RECnRun ${id} is loaded. Turn on "Allow in Incognito" on its details page,`);
  console.log("then follow docs/poc-zephyr-runbook.md. Close Chromium to end the run.");
  return context;
}

/** Stops this run's website and deletes its profile, captures, and build. */
function cleanUp() {
  try {
    if (server?.pid !== undefined) process.kill(-server.pid);
  } catch {
    // The website's processes have already exited.
  }
  rmSync(work, { recursive: true, force: true });
  console.log("Deleted the run's profile, its captures, and the build.");
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
let context;
// Before Chromium is open, a signal ends the run at once, as nothing waits for a window.
const stop = () => {
  if (context !== undefined) return void context.close();
  cleanUp();
  process.exit(130);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  build();
  context = await open(await site());
  await new Promise((resolve) => context.on("close", resolve));
} finally {
  cleanUp();
}
