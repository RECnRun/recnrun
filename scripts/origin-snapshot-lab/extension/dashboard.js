// The lab's dashboard: each control sends one command to the worker (ui.js) and logs the outcome.
const $ = (id) => document.getElementById(id);
const IDENTITY = /^[\w-]{1,20}$/;
const ARMED_MS = 5000;
const POLL_MS = 2000;
const IDENTITY_TEXT = {
  null: "not started",
  lost: "unknown: the lab's worker restarted",
  unknown: "unknown: a switch failed midway",
};
let armed = false;
let shownCaptures = "";

const incognito = () =>
  document.querySelector('input[name="window"]:checked')?.value === "incognito";

async function send(ui, extra = {}) {
  const answer = await chrome.runtime.sendMessage({ ui, incognito: incognito(), ...extra });
  if (!answer?.ok) throw new Error(answer?.error ?? "the lab did not answer");
  return answer.result;
}

function log(text, kind = "ok") {
  const item = document.createElement("li");
  item.className = kind;
  item.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  $("log").prepend(item);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function receiptLine({ from, to, kind, tabs, ms, cookies }) {
  const swapped = cookies ? `; cookies ${cookies.removed} removed, ${cookies.set} set` : "";
  return `${from} → ${to}: ${kind}, ${plural(tabs, "tab")}, ${ms} ms${swapped}`;
}

function hintFor({ identity, tabs }) {
  if (identity === "lost" || identity === "unknown") {
    return "Forget everything, then start again. If the site's sign-in is wrong, restore an identity's cookies first.";
  }
  if (tabs === 0) return "Open the site in a tab of this window type first.";
  return identity === null ? "Sign in as the first identity, then press Start." : "";
}

function button(label, data, disabled = false) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.disabled = disabled;
  Object.assign(element.dataset, data);
  return element;
}

function captureRow(capture, current) {
  const row = document.createElement("tr");
  row.dataset.capture = capture.identity;
  const contents = [
    plural(capture.local, "key"),
    plural(capture.databases, "database"),
    plural(capture.cookies, "cookie"),
  ].join(", ");
  for (const text of [capture.identity, new Date(capture.capturedAt).toLocaleString(), contents]) {
    row.insertCell().textContent = text;
  }
  row
    .insertCell()
    .append(
      button("Switch", { switch: capture.identity }, capture.identity === current),
      button("Restore cookies", { cookies: capture.identity }),
    );
  return row;
}

/** Rebuilt only when it changed, so a poll never replaces a row under the pointer. */
function renderCaptures(captures, current) {
  const key = JSON.stringify([captures, current]);
  if (key === shownCaptures) return;
  shownCaptures = key;
  $("captures").replaceChildren(...captures.map((capture) => captureRow(capture, current)));
  $("no-captures").hidden = captures.length > 0;
}

function render(state) {
  $("no-site").hidden = state.origin !== null;
  $("controls").hidden = state.origin === null;
  if (!state.origin) return;
  $("site").textContent = state.origin;
  $("hosts").textContent = state.cookieHosts.join(", ") || "none";
  $("identity").textContent = IDENTITY_TEXT[state.identity] ?? state.identity;
  $("tabs").textContent =
    `${plural(state.tabs, "tab")} of the site, ${state.grouped} in a RECnRun group`;
  $("hint").textContent = hintFor(state);
  $("start").hidden = state.grouped > 0;
  $("incognito").disabled = !state.incognitoAllowed;
  $("incognito-hint").hidden = state.incognitoAllowed;
  $("force-clear").checked = state.forceClear;
  renderCaptures(state.captures, state.identity);
}

const refresh = () =>
  send("status").then(render, (error) => log(`Status: ${error.message}`, "error"));

/** Runs one command with the controls disabled, then logs it and shows the new state. */
async function run(label, ui, extra, describe) {
  document.body.classList.add("busy");
  $("controls").disabled = true;
  try {
    log(describe(await send(ui, extra)));
  } catch (error) {
    log(`${label}: ${error.message}`, "error");
  } finally {
    await refresh();
    $("controls").disabled = false;
    document.body.classList.remove("busy");
  }
}

/** The identity typed in the form, or null after logging why it is not one. */
function typed() {
  const to = $("to").value.trim();
  if (IDENTITY.test(to)) return to;
  log("An identity is 1 to 20 letters, digits, '-' or '_'", "error");
  return null;
}

function disarm() {
  armed = false;
  $("forget").textContent = "Forget everything";
}

function forget() {
  if (armed) {
    disarm();
    void run("Forget", "forget", {}, () => "Forgot every capture and identity");
    return;
  }
  armed = true;
  $("forget").textContent = "Click again to delete every capture";
  log("Forget everything: click again within 5 s to confirm");
  setTimeout(disarm, ARMED_MS);
}

function onCaptureClick({ target }) {
  const { switch: to, cookies } = target.dataset;
  if (to) void run("Switch", "switch", { to }, receiptLine);
  if (cookies) {
    void run(
      "Restore cookies",
      "restoreCookies",
      { to: cookies },
      (result) =>
        `${cookies}'s cookies: ${result.removed} removed, ${result.set} set, ${result.expired} expired`,
    );
  }
}

$("start").addEventListener(
  "click",
  () => void run("Start", "start", {}, (title) => `Started: ${title}`),
);
$("switch-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const to = typed();
  if (to) void run("Switch", "switch", { to }, receiptLine);
});
$("reset").addEventListener("click", () => {
  const to = typed();
  if (to) void run("Start empty", "reset", { to }, receiptLine);
});
$("captures").addEventListener("click", onCaptureClick);
$("force-clear").addEventListener("change", ({ target }) => {
  void run(
    "Settings",
    "settings",
    { forceClear: target.checked },
    (settings) => `Force clearing ${settings.forceClear ? "on" : "off"}`,
  );
});
$("forget").addEventListener("click", forget);
for (const radio of document.querySelectorAll('input[name="window"]')) {
  radio.addEventListener("change", () => void refresh());
}
void refresh();
setInterval(() => {
  if (!document.body.classList.contains("busy")) void send("status").then(render, () => undefined);
}, POLL_MS);
