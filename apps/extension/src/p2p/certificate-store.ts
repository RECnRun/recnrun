const DB_NAME = "recnrun-p2p";
const STORE = "certificates";
const KEY = "link";
/** Renewed a day before Chrome would refuse it; a new one needs a new pairing. */
const MARGIN_MS = 24 * 60 * 60 * 1000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

/**
 * The DTLS certificate this profile always uses, so its fingerprint identifies it across
 * connections. RTCCertificate is structured-cloneable; its private key never leaves the browser.
 */
export async function persistentCertificate(now = Date.now()): Promise<RTCCertificate> {
  const db = await open();
  try {
    const stored = await run<unknown>(db, "readonly", (store) => store.get(KEY));
    if (stored instanceof RTCCertificate && stored.expires - MARGIN_MS > now) return stored;
    const created = await RTCPeerConnection.generateCertificate({
      name: "ECDSA",
      namedCurve: "P-256",
    } as EcKeyGenParams);
    await run(db, "readwrite", (store) => store.put(created, KEY));
    return created;
  } finally {
    db.close();
  }
}

/** The certificate's SHA-256 fingerprint, written as SDP writes it. */
export function certificateFingerprint(certificate: RTCCertificate): string | undefined {
  const sha = certificate.getFingerprints().find(({ algorithm }) => algorithm === "sha-256");
  return sha?.value?.toUpperCase();
}
