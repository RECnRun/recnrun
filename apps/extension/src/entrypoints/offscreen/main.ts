import { pocEnabled } from "@/config/origins";
import { startPocFileRead } from "@/offscreen/poc-file-read";
import { startPocFingerprint } from "@/offscreen/poc-fingerprint";
import { startPocLiveness } from "@/offscreen/poc-liveness";
import { pocDownloadsRendezvous } from "@/offscreen/poc-rendezvous";
import { startOffscreen } from "@/offscreen/start";
import { persistentCertificate } from "@/p2p/certificate-store";

// One certificate per document, so the presence announces the one the links use.
let held: Promise<RTCCertificate> | undefined;
const certificate = () => (held ??= persistentCertificate());

// POC builds rendezvous over Downloads (P3.1); the folder-watch command stays the same in both.
const poc = pocEnabled(import.meta.env.MODE);
const offscreen = startOffscreen({
  certificate,
  ...(poc ? { rendezvous: pocDownloadsRendezvous() } : {}),
});
// Every build's HELLO signs the certificate the links use, so every build answers for it.
startPocFingerprint({ certificate });
if (poc) {
  startPocFileRead();
  startPocLiveness(offscreen.liveness);
}
