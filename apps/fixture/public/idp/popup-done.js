await fetch("/__marker?name=idp-popup-done:start", { cache: "no-store" });

const target = new URLSearchParams(location.search).get("origin");
const { user } = await (await fetch("/whoami")).json();

// The target origin comes from the opener, so only that origin can read the message.
if (window.opener && target) window.opener.postMessage({ type: "fixture-login", user }, target);
window.close();
