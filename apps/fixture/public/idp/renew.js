await fetch("/__marker?name=idp-renew:start", { cache: "no-store" });

const target = new URLSearchParams(location.search).get("origin");
const response = await fetch("/renew", { method: "POST" });
const { user } = await response.json();

if (target) window.parent.postMessage({ type: "fixture-renew", ok: response.ok, user }, target);
