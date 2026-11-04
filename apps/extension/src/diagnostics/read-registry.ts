import * as v from "valibot";
import {
  DEFAULT_NAMESPACE,
  NamespaceSchema,
  fileUrlFor,
  registryPath,
} from "@/p2p/downloads-rendezvous";
import { readRegistry } from "@/p2p/registry";
import type { Registry } from "@/p2p/registry";
import { pocPresenceStore } from "@/storage/poc-presence-repository";

export interface RegistryReadDependencies {
  /** The Downloads root this profile learned from Chrome, or null before its first presence. */
  root: () => Promise<string | null>;
  /** The stored namespace override, not yet validated. */
  namespace: () => Promise<unknown>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface OwnRegistry {
  reason: string;
  namespace: string;
  peers: Registry["peers"][string][];
}

/** The file's text, or undefined when it cannot be read, which readRegistry counts as absent. */
async function readText(path: string, fetcher: typeof fetch): Promise<string | undefined> {
  try {
    return await (await fetcher(fileUrlFor(path))).text();
  } catch {
    return undefined;
  }
}

/** The launcher's registry.json under this profile's own Downloads root, through readRegistry. */
export async function readOwnRegistry(deps: RegistryReadDependencies): Promise<OwnRegistry> {
  const stored = await deps.namespace();
  const namespace = v.is(NamespaceSchema, stored) ? stored : DEFAULT_NAMESPACE;
  const root = await deps.root();
  if (root === null) return { reason: "no-root", namespace, peers: [] };
  const text = await readText(`${root}/${registryPath(namespace)}`, deps.fetcher ?? fetch);
  const { publication, reason } = readRegistry(text, undefined, (deps.now ?? Date.now)());
  if (!publication) return { reason, namespace, peers: [] };
  if (publication.namespace !== namespace)
    return { reason: "other-namespace", namespace, peers: [] };
  return { reason, namespace, peers: Object.values(publication.peers) };
}

function storedDependencies(): RegistryReadDependencies {
  const store = pocPresenceStore();
  return { root: store.root.read, namespace: store.namespace };
}

/** E4 (POC PLAN.md P2.1): `window.__poc.readRegistry()`, merged into what is there. */
export function installReadRegistry(
  target: object,
  deps: RegistryReadDependencies = storedDependencies(),
): void {
  const holder = target as { __poc?: Record<string, unknown> };
  holder.__poc = { ...holder.__poc, readRegistry: () => readOwnRegistry(deps) };
}
