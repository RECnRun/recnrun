import { API, IDP, attempt, currentUser, firstPaint, marker, show } from "./page.js";

await marker("index:start");

const here = encodeURIComponent(location.href);
const origin = encodeURIComponent(location.origin);

async function refreshUser() {
  const user = await currentUser();
  show("user", user ? `Signed in as ${user}` : "Signed out");
}

document.getElementById("login").href = `${IDP}/login?redirect=${here}`;
document.getElementById("logout").href = `${IDP}/logout?redirect=${here}`;
document.getElementById("popup-login").addEventListener("click", () => {
  window.open(`${IDP}/login?mode=popup&origin=${origin}`, "fixture-login", "width=480,height=600");
});
document.getElementById("renew").addEventListener("click", () => {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = `${IDP}/renew.html?origin=${origin}`;
  document.body.append(frame);
});
async function act() {
  const result = await attempt(async () => {
    const response = await fetch(`${API}/act?op=click`, { method: "POST", credentials: "include" });
    return response.json();
  });
  show("log", result);
}

document.getElementById("act").addEventListener("click", () => void act());
window.addEventListener("message", (event) => {
  if (event.origin !== IDP) return;
  show("log", event.data);
  void refreshUser();
});

await refreshUser();
await firstPaint("index");
