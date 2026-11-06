import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { namespaceFolder } from "../../experiments/fixtures/e4-launcher.ts";
import type { VirtualPeer } from "../../experiments/fixtures/e5-virtual.ts";
import type { DownloadsGroup } from "./downloads-profiles.ts";

/*
 * The catalog of P3.3's forged sender, who writes files as the same OS user: with the launcher's
 * runs stopped, it rewrites registry.json itself and lists its virtual peer under a real profile's
 * id, with the virtual peer's certificate and boot. What it cannot write is a statement the
 * profile's pinned identity key signed.
 */

const REFRESH_MS = 10_000;
const TTL_MS = 60_000;

interface RegistryEntry {
  profileId: string;
  displayName: string;
  fingerprint: string;
  lastSeenAt: number;
  expiresAt: number;
  boot: string;
}

interface Registry {
  writtenAt: number;
  peers: Record<string, RegistryEntry>;
}

/** Lists `peer` in the group's registry.json in place of its real entry, rewritten until stopped. */
export async function forgeRegistry(group: DownloadsGroup, peer: VirtualPeer) {
  const path = join(namespaceFolder(group.downloads), "registry.json");
  const last = JSON.parse(await readFile(path, "utf8")) as Registry;
  const real = last.peers[peer.profileId];
  if (!real) throw new Error(`The catalog does not list ${peer.profileId} to forge.`);
  const write = async () => {
    const now = Date.now();
    const fresh = { lastSeenAt: now, expiresAt: now + TTL_MS };
    const forged = { ...real, displayName: peer.displayName, fingerprint: peer.fingerprint };
    const peers = Object.fromEntries(
      Object.entries(last.peers).map(([id, entry]) => [
        id,
        { ...(id === peer.profileId ? { ...forged, boot: peer.boot } : entry), ...fresh },
      ]),
    );
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...last, writtenAt: now, peers }));
    await rename(temporary, path);
  };
  await write();
  const timer = setInterval(() => void write().catch(() => undefined), REFRESH_MS);
  return () => clearInterval(timer);
}
