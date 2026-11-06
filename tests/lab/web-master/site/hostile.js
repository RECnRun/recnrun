// Changed same-origin code of W.trust: reads the stored master key and signs whatever it likes.
import { canonical } from "./jobs.js";
import { links, nextMessage } from "./master.js";

const request = (operation) =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });

const storedKey = async () => {
  const database = await request(indexedDB.open("recnrun-lab", 1));
  return request(database.transaction("keys").objectStore("keys").get("master"));
};

const signed = async (fields) => {
  const { privateKey } = await storedKey();
  const data = new TextEncoder().encode(canonical(fields));
  const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  return { ...fields, signature: btoa(String.fromCharCode(...new Uint8Array(raw))) };
};

const send = (name, message, replyType) => {
  const { channel } = links.get(name);
  const reply = replyType ? nextMessage(channel, replyType) : Promise.resolve(null);
  channel.send(JSON.stringify(message));
  return reply;
};

window.lab.hostile = {
  job: async (name, fields) => send(name, { type: "job", job: await signed(fields) }, "job-reply"),
  send: (name, message) => send(name, message),
};
document.getElementById("status").textContent = "ready hostile";
