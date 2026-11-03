await fetch("/__marker?name=idp-login:start", { cache: "no-store" });

const params = new URLSearchParams(location.search);
const popupDone = `${location.origin}/popup-done.html?origin=${encodeURIComponent(params.get("origin") ?? "")}`;
const target = params.get("mode") === "popup" ? popupDone : params.get("redirect");

document.getElementById("redirect").value = target ?? "http://app.localhost:4600/";
