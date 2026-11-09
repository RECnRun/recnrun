// Types of identity.js for the Node tests of the worker identity.
export interface Identity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  spki: string;
  source: "pk8" | "ephemeral";
}

export declare function loadIdentity(deps: {
  readPk8: () => Promise<Uint8Array | null>;
}): Promise<Identity>;
