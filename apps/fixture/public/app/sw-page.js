import { attempt, firstPaint, marker, show } from "./page.js";

await marker("sw:start");

const VARIANTS = {
  classic: { url: "/sw-main.js?variant=classic", type: "classic" },
  module: { url: "/sw-main.js?variant=module", type: "module" },
  imports: { url: "/sw-imports.js?variant=imports", type: "classic" },
  static: { url: "/sw-static.js?variant=static", type: "module" },
  dynamic: { url: "/sw-dynamic.js?variant=dynamic", type: "module" },
};
// An arbitrary valid P-256 public key: the subscription attempt is what the fixture exercises.
const PUSH_KEY =
  "BE0QcdMSUVSkWmxPrKKurcQJ4OB5L2kynYO6DImw55V9xrn_QyG7DxuVakwYzHs6RA6DeDjWK12AM1IGb-59sfY";

const name = new URLSearchParams(location.search).get("sw") ?? "classic";
const variant = VARIANTS[name] ?? VARIANTS.classic;

function activated(registration) {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (worker.state === "activated") return Promise.resolve(worker);
  return new Promise((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve(worker);
      if (worker.state === "redundant") reject(new Error("the service worker became redundant"));
    });
  });
}

function askReport(worker) {
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("message", (event) => resolve(event.data), {
      once: true,
    });
    navigator.serviceWorker.startMessages();
    worker.postMessage("report");
  });
}

const report = { variant: name };
report.worker = await attempt(async () => {
  const registration = await navigator.serviceWorker.register(variant.url, {
    type: variant.type,
    scope: "/",
  });
  const worker = await activated(registration);
  report.sync = await attempt(() => registration.sync.register("fixture-sync").then(() => "ok"));
  report.push = await attempt(async () => {
    const options = { userVisibleOnly: true, applicationServerKey: PUSH_KEY };
    return (await registration.pushManager.subscribe(options)).endpoint;
  });
  return askReport(worker);
});

show("report", report);
await firstPaint("sw");
