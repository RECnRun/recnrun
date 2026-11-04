import { pocEnabled } from "@/config/origins";
import { startPocFileRead } from "@/offscreen/poc-file-read";
import { startPocFingerprint } from "@/offscreen/poc-fingerprint";
import { startOffscreen } from "@/offscreen/start";
import { persistentCertificate } from "@/p2p/certificate-store";

// One certificate per document, so the presence announces the one the links use.
let held: Promise<RTCCertificate> | undefined;
const certificate = () => (held ??= persistentCertificate());

startOffscreen({ certificate });
if (pocEnabled(import.meta.env.MODE)) {
  startPocFileRead();
  startPocFingerprint({ certificate });
}
