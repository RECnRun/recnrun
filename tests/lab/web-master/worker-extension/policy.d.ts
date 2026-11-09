// Types of policy.js for the Node tests of the policy file and its fallback.
export interface Viewport {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface Policy {
  v: 1;
  workspace: string;
  root: string;
  generation: number;
  masterSpki: string;
  allow: string[];
  interactEnabled: boolean;
  exchangeUrl: string;
  viewport: Viewport;
}

export interface Provision {
  masterKey: JsonWebKey;
  allowlist: string[];
  interactEnabled?: boolean;
  viewport?: Viewport;
  generation?: number;
  source?: "policy";
}

export interface Filed {
  policy: Policy;
  bytes: Uint8Array;
}

export declare function parsePolicy(bytes: Uint8Array): Policy;

export declare function createProvision(deps: {
  readPolicy: () => Promise<Uint8Array | null>;
  readStorage: () => Promise<unknown>;
}): {
  current(): Promise<Provision | undefined>;
  filed(): Promise<Filed | null>;
};
