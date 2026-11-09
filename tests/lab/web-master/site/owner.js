// LAB-ONLY owner page: choose the folder, pair, enter a URL, Launch, then drive the page by hand.
import { track } from "./heartbeat.js";
import { storedPair } from "./jobs.js";
import { LINK, launch, pinWorker } from "./owner-launch.js";
import { ensureMarker, pickFolder, readFile, readMarker, writeFile } from "./owner-files.js";
import { fingerprint } from "./owner-pairing.js";
import { banner, display } from "./owner-state.js";
import { recall, remember } from "./owner-store.js";

/** @type {Record<string, (...args: unknown[]) => Promise<any>>} */
const lab = /** @type {any} */ (window).lab;
const TICK_MS = 1_000;

/** @type {any} */
const ui = {
  tracker: null,
  handle: null,
  wrote: false,
  reconnect: false,
  url: "http://127.0.0.1:47812/interact",
};
const text = (tag, content, parent) => {
  const element = document.createElement(tag);
  element.textContent = content;
  parent?.append(element);
  return element;
};

const panel = document.createElement("section");
panel.style.cssText = "position:fixed;left:0;top:0;right:0;z-index:10;padding:8px;background:#eee";
const bannerLine = text("p", "starting", panel);
bannerLine.setAttribute("role", "status");
const detail = text("p", "", panel);
const actions = document.createElement("div");
panel.append(actions);

const say = (message) => {
  detail.textContent = message;
};

const control = (label, run) => {
  const button = text("button", label, actions);
  button.type = "button";
  button.addEventListener("click", () => void run().catch((error) => say(`${label}: ${error}`)));
  return button;
};

const masterSpki = async () => {
  const pair = await storedPair();
  return pair ? new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) : null;
};

const pairNow = async () => {
  if (!ui.handle) return;
  await lab.pair();
  const spki = await masterSpki();
  const written = await writeFile(ui.handle, "pairing/master.spki", spki);
  ui.wrote = written.status === "ok";
  say(
    ui.wrote ? "Confirm the fingerprints in the launcher terminal" : `pairing: ${written.status}`,
  );
};

const choose = async () => {
  const handle = await pickFolder(() => window.showDirectoryPicker({ mode: "readwrite" }));
  if (!handle) return;
  ui.handle = handle;
  await remember("handle", handle);
  await ensureMarker(handle);
};

const renew = async () => {
  await ui.handle.requestPermission({ mode: "readwrite" });
};

const ACTIONS = { choose, renew, pair: pairNow };

const permissionOf = async (handle) => {
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
};

const observe = async () => {
  const { handle } = ui;
  const permission = handle ? await permissionOf(handle) : "prompt";
  const state = {
    handle,
    permission,
    folder: "ok",
    marker: "ok",
    masterFp: null,
    reconnect: ui.reconnect,
  };
  if (!handle || permission !== "granted") return state;
  const marker = await readMarker(handle);
  if (marker.marker === "folder-missing") return { ...state, folder: "missing" };
  const beat = await readFile(handle, "launcher/heartbeat");
  const raw = beat.status === "ok" ? new TextDecoder().decode(beat.bytes) : null;
  ui.tracker = track(ui.tracker, raw, Date.now());
  const spki = await masterSpki();
  const pin = await pinWorker(handle);
  return {
    ...state,
    marker: marker.marker,
    heartbeat: ui.tracker.heartbeat,
    stale: ui.tracker.stale,
    masterFp: spki ? await fingerprint(spki) : null,
    workerMismatch: pin.pin === "mismatch",
  };
};

const bannerAction = document.createElement("button");
bannerAction.type = "button";
bannerAction.hidden = true;
bannerAction.addEventListener("click", () => {
  const run = ACTIONS[bannerAction.dataset.action ?? ""];
  void run?.().catch((error) => say(`${bannerAction.textContent}: ${error}`));
});

// Details are written only when the banner changes, so a launch's progress is not overwritten.
const render = (state) => {
  const shown = banner(state);
  const changed = bannerLine.dataset.banner !== shown.id;
  bannerLine.textContent = shown.text;
  bannerLine.dataset.banner = shown.id;
  bannerAction.hidden = !shown.action;
  bannerAction.dataset.action = shown.action ?? "";
  bannerAction.textContent =
    shown.action === "renew"
      ? "Renew access"
      : shown.action === "pair"
        ? "Pair again"
        : "Choose folder";
  if (changed && shown.command) say(shown.command);
  if (changed && shown.fingerprints) say(`master ${shown.fingerprints.master}`);
  return shown;
};

// A paired=none launcher is answered once with this page's key.
const autoPair = async (state, shown) => {
  if (shown.id !== "confirm" || ui.wrote) return;
  await pairNow();
  if (state.masterFp) say(`master ${display(state.masterFp)}`);
};

const tick = async () => {
  try {
    const state = await observe();
    await autoPair(state, render(state));
  } catch (error) {
    say(`page: ${String(error)}`);
  }
};

const startLaunch = async () => {
  const state = await observe();
  if (banner(state).id !== "ready") return say("not ready: follow the banner first");
  const key = (await storedPair())?.privateKey;
  const marker = await readMarker(ui.handle);
  const heartbeat = ui.tracker;
  say("launching: the owner's Chrome stays untouched");
  const result = await launch({
    root: ui.handle,
    lab,
    key,
    workspace: marker.workspaceId,
    session: heartbeat.session,
    url: urlInput.value,
    say,
  });
  if (!result.ok) return say(`refused: ${JSON.stringify(result)}`);
  ui.reconnect = true;
  await lab.interactObserve(LINK);
  void lab.interactWatchViewport(LINK, document.getElementById("visual"));
  say("launched: interact on the image below");
};

const urlInput = document.createElement("input");
urlInput.type = "url";
urlInput.value = ui.url;
urlInput.setAttribute("aria-label", "Target URL");
urlInput.style.width = "28em";
actions.append(urlInput, bannerAction);
control("Choose folder", choose);
control("Launch", startLaunch);
control("Reconnect", startLaunch);

const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));
Object.assign(image.style, {
  position: "fixed",
  left: "8px",
  top: "120px",
  width: "960px",
  height: "540px",
  objectFit: "contain",
  background: "#333",
  zIndex: "9",
});
document.body.prepend(panel);

recall("handle").then(
  (handle) => {
    ui.handle = handle ?? null;
    return tick();
  },
  () => tick(),
);
setInterval(() => void tick(), TICK_MS);
