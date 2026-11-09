// The owner page's banner: a pure reducer over what the page observed; the first match wins.
export const START_COMMAND =
  "sh tests/lab/web-master/launcher/launcher.sh start ~/RECnRun-lab --allow-any";
const BUSY = ["installing", "launching", "delivering", "stopping"];
const GROUPS = 5;

/** The first 20 hex of a fingerprint in 5 groups of 4. */
export const display = (fp) =>
  Array.from({ length: GROUPS }, (_, index) => fp.slice(index * 4, index * 4 + 4)).join(" ");

const choose = (id, text) => ({ id, text, action: "choose" });

// Folder trust first: the page cannot read anything until it has a usable folder.
const folder = (state) => {
  if (!state.handle) return choose("no-handle", "Choose the RECnRun folder");
  if (state.permission === "prompt")
    return { id: "permission-prompt", text: "Renew folder access", action: "renew" };
  if (state.permission === "denied")
    return choose(
      "permission-denied",
      "Access was blocked: allow File editing for this site in site settings, or choose the folder again",
    );
  if (state.folder === "missing") return choose("folder-missing", "Folder missing: choose again");
  if (state.marker !== "ok") return choose("not-a-folder", "Not a RECnRun folder: choose again");
  return null;
};

const trust = (state, heartbeat) => {
  if (state.workerMismatch)
    return {
      id: "worker-changed",
      text: "The worker's key changed: refused. Follow the recovery command in the launcher terminal, then pair again",
    };
  const { paired } = heartbeat;
  const other = /^[0-9a-f]{64}$/.test(paired) && paired !== state.masterFp;
  if (other && heartbeat.state !== "pairing")
    return {
      id: "key-changed",
      text: "The launcher is paired with a different key: re-pair and confirm in the launcher terminal",
      action: "pair",
    };
  if (paired === "rejected")
    return { id: "pairing-rejected", text: "Pairing refused", action: "pair" };
  if (paired === "none" || heartbeat.state === "pairing")
    return {
      id: "confirm",
      text: "Confirm in the launcher terminal",
      fingerprints: { master: display(state.masterFp ?? "") },
    };
  return null;
};

export const banner = (state) => {
  const blocked = folder(state);
  if (blocked) return blocked;
  const { heartbeat } = state;
  if (!heartbeat || state.stale)
    return { id: "launcher", text: "Start the launcher", command: START_COMMAND };
  const untrusted = trust(state, heartbeat);
  if (untrusted) return untrusted;
  if (BUSY.includes(heartbeat.state))
    return { id: "busy", text: `Launcher is ${heartbeat.state}`, busy: heartbeat.state };
  return { id: "ready", text: "Ready", reconnect: state.reconnect };
};
