// LAB-ONLY manual mode of M-TW.16 (w-manual.spec.ts): the owner drives this page by hand.
import { retrying } from "./retry.js";

const NAME = "worker";
const PAGES = [
  ["Counter", "/interact"],
  ["Form", "/interact/form"],
  ["Scroll", "/interact/scroll"],
  ["Slider", "/interact/drag"],
];

/** @type {Record<string, (...args: unknown[]) => Promise<any>>} */
const lab = /** @type {any} */ (window).lab;
let target = "";

const post = async (path, body) => {
  const response = await fetch(path, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json();
};

const panel = document.createElement("section");
panel.style.cssText = "position:fixed;left:0;top:0;right:0;z-index:10;padding:8px;background:#eee";
const status = document.createElement("p");
status.setAttribute("role", "status");
const say = (text) => {
  status.textContent = text;
  void post("/manual/log", { text }).catch(() => null);
};

const button = (label, action) => {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener(
    "click",
    () => void action().catch((error) => say(`${label}: ${error}`)),
  );
  panel.append(element);
  return element;
};

// The frame fills a 960×540 box under the panel; input maps through `contain` letterboxing.
const showImage = () => {
  const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));
  const style = { position: "fixed", left: "8px", top: "96px", width: "960px", height: "540px" };
  Object.assign(image.style, style, { objectFit: "contain", background: "#333", zIndex: "9" });
};

const startLease = async (url) => {
  const reply = await retrying(() => lab.interactStart(NAME, url));
  if (!reply.ok) say(`start refused: ${JSON.stringify(reply)}`);
  return reply;
};

const open = async (label, path) => {
  await lab.interactStop(NAME).catch(() => null);
  const started = await startLease(`${target}${path}`);
  if (!started.ok) throw new Error(`interactStart ${JSON.stringify(started)}`);
  const observed = await lab.interactObserve(NAME);
  if (!observed.ok) throw new Error(`interactObserve ${JSON.stringify(observed)}`);
  showImage();
  say(`${label}: interact on the image below`);
};

const pages = PAGES.map(([label, path]) => button(label, () => open(label, path)));
const finish = button("Finish", async () => {
  await lab.interactStop(NAME).catch(() => null);
  await post("/manual/finish", {});
  say("finished: read the report in the terminal");
});
for (const element of [...pages, finish]) element.disabled = true;

const connect = button("Connect", async () => {
  connect.disabled = true;
  say("pairing and starting the worker (about 20 s)");
  ({ target } = await post("/manual/key", await lab.pair()));
  say("linking over WebRTC");
  const { answer, identity } = await post("/manual/link", { sdp: await lab.offer(NAME) });
  await lab.accept(NAME, answer);
  const proof = await lab.authenticate(NAME, identity);
  if (!proof.ok) throw new Error(`authenticate ${JSON.stringify(proof)}`);
  for (const element of [...pages, finish]) element.disabled = false;
  say("linked: pick a page");
});

panel.append(status);
document.body.prepend(panel);
// Closing the tab mid-drag is a check of its own: the spec times the release from this beacon.
addEventListener("pagehide", () => navigator.sendBeacon("/manual/closing", "{}"));
say("ready: press Connect");
