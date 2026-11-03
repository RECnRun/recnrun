import { onClick, show, start } from "../fixture.js";

// The server sends an expired session to `?login`; a signed-in one reaches the account view.
const login = new URLSearchParams(location.search).has("login");
document.getElementById(login ? "login" : "account").hidden = false;

let orders = 0;
onClick("order", "order", () => {
  orders += 1;
  show("order-count", `${orders} placed`);
});

async function sessionMatchesView() {
  const { signedIn } = await (await fetch("/api/session")).json();
  if (signedIn === login)
    throw new Error(`Session ${signedIn} shown as ${login ? "login" : "account"}`);
}

await start("session", { counters: ["order"], selfTest: sessionMatchesView });
