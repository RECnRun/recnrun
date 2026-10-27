// A dedicated or shared worker that holds a connection to app-db while it lives.
let held = null;
const hold = new URL(self.location.href).searchParams.has("hold");

async function connect() {
  const names = (await indexedDB.databases()).map((info) => info.name);
  if (!names.includes("app-db")) return "absent";
  return new Promise((resolve) => {
    const request = indexedDB.open("app-db");
    request.onsuccess = () => {
      held = request.result;
      // A well-behaved holder closes on versionchange; the lab keeps it open on purpose.
      resolve("held");
    };
    request.onerror = () => resolve("error");
  });
}

const ready = hold ? connect() : Promise.resolve("none");
const answer = async (port) => port.postMessage({ held: await ready, open: held !== null });
self.onmessage = (event) => answer(event.target);
self.onconnect = (event) => {
  const [port] = event.ports;
  port.onmessage = () => answer(port);
};
