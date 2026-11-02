import { onClick, show, start } from "../fixture.js";

const KEY = "recnrun-fixture";

function cookie() {
  const entry = document.cookie.split("; ").find((each) => each.startsWith(`${KEY}=`));
  return entry?.slice(KEY.length + 1);
}

function showValues() {
  show("local-value", localStorage.getItem(KEY) ?? "(none)");
  show("session-value", sessionStorage.getItem(KEY) ?? "(none)");
  show("cookie-value", cookie() ?? "(none)");
}

const ACTIONS = {
  "local-set": () => localStorage.setItem(KEY, "fixture-local"),
  "local-remove": () => localStorage.removeItem(KEY),
  "session-set": () => sessionStorage.setItem(KEY, "fixture-session"),
  "session-remove": () => sessionStorage.removeItem(KEY),
  "cookie-set": () => (document.cookie = `${KEY}=fixture-cookie; path=/; SameSite=Lax`),
  "cookie-clear": () => (document.cookie = `${KEY}=; path=/; max-age=0`),
};

for (const [name, action] of Object.entries(ACTIONS)) {
  onClick(name, name, () => {
    action();
    showValues();
  });
}

await start("storage", { counters: Object.keys(ACTIONS), selfTest: showValues });
