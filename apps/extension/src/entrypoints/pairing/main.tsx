import { startPairing } from "@/pairing/start";
import { createPeerClient } from "@/views/peer-client";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";
import "@/pairing/pairing.css";

const root = document.getElementById("app");
if (root) startPairing(root, createPeerClient());
