import { browser } from "wxt/browser";
import { ask, peerRequest } from "@/messaging/peer-protocol";
import { startPairing } from "@/pairing/start";
import { watchPeer } from "@/storage/peer-repository";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";
import "@/pairing/pairing.css";

const root = document.getElementById("app");
if (root) {
  startPairing(root, {
    ask: (request) =>
      ask((message) => browser.runtime.sendMessage(message), peerRequest(request as never)),
    watch: watchPeer,
  });
}
