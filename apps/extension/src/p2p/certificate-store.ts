const DB_NAME = "recnrun-p2p";
const STORE = "certificates";
const KEY = "link";
/** Renewed a day before Chrome would refuse it; a new certificate needs a new pairing. */
const MARGIN_MS = 24 * 60 * 60 * 1000;

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return settle(request);
}

const objectStore = (db: IDBDatabase, mode: IDBTransactionMode) =>
  db.transaction(STORE, mode).objectStore(STORE);

/**
 * The DTLS certificate this profile always uses, so its fingerprint identifies the profile across
 * connections. An RTCCertificate is structured-cloneable; its private key never leaves Chrome.
 */
export async function persistentCertificate(now = Date.now()): Promise<RTCCertificate> {
  const db = await openDatabase();
  try {
    const stored: unknown = await settle(objectStore(db, "readonly").get(KEY));
    if (stored instanceof RTCCertificate && stored.expires - MARGIN_MS > now) return stored;
    const keys: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
    const created = await RTCPeerConnection.generateCertificate(keys);
    await settle(objectStore(db, "readwrite").put(created, KEY));
    return created;
  } finally {
    db.close();
  }
}

/** The certificate's SHA-256 fingerprint, written as an SDP writes it. */
export function certificateFingerprint(certificate: RTCCertificate): string | undefined {
  const sha = certificate.getFingerprints().find(({ algorithm }) => algorithm === "sha-256");
  return sha?.value?.toUpperCase();
}
