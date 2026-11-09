// Types of owner-pairing.js for the Node tests of the owner page's keys, requests and answers.
export interface RequestFields {
  workspace: string;
  session: string;
  request: string;
  root: string;
  offer: string;
  attempt: string;
  expires: number;
}
export declare const toBase64: (bytes: Uint8Array) => string;
export declare const toBase64Url: (bytes: Uint8Array) => string;
export declare const fromBase64Url: (text: string) => Uint8Array<ArrayBuffer>;
export declare const spkiOk: (bytes: Uint8Array) => boolean;
export declare const sha256Hex: (bytes: Uint8Array) => Promise<string>;
export declare const fingerprint: (spki: Uint8Array) => Promise<string>;
export declare const buildRequest: (fields: RequestFields, key: CryptoKey) => Promise<string>;
export declare const signOffer: <T extends object>(
  fields: T,
  key: CryptoKey,
) => Promise<T & { signature: string }>;
export declare const verifyAnswer: (
  answer: unknown,
  pinnedSpki: Uint8Array,
  expected: { attempt: string; nonce: string; root: string },
) => Promise<{ ok: boolean; reason?: string }>;
export declare const spkiToJwk: (spki: Uint8Array) => Promise<JsonWebKey>;
