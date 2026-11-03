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
  "local-clear": () => localStorage.clear(),
  "session-set": () => sessionStorage.setItem(KEY, "fixture-session"),
  "session-remove": () => sessionStorage.removeItem(KEY),
  "cookie-set": () => (document.cookie = `${KEY}=fixture-cookie; path=/; SameSite=Lax`),
  "cookie-clear": () => (document.cookie = `${KEY}=; path=/; max-age=0`),
  // The page cannot read an HttpOnly cookie, so it shows what the server said it did.
  "httponly-set": () => httpOnly(""),
  "httponly-clear": () => httpOnly("?clear=1"),
};

async function httpOnly(query) {
  const answer = await (await fetch(`/api/cookies${query}`)).json();
  show("httponly-value", answer.httpOnly);
}

for (const [name, action] of Object.entries(ACTIONS)) {
  onClick(name, name, async () => {
    await action();
    showValues();
  });
}

await start("storage", { counters: Object.keys(ACTIONS), selfTest: showValues });
