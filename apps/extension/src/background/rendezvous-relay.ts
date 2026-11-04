import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { downloadsWriter } from "@/background/downloads-publisher";
import type {
  DownloadItem,
  DownloadsEraser,
  DownloadsPort,
} from "@/background/downloads-publisher";
import { OFFSCREEN_PAGE } from "@/background/listener";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocRendezvousRequestSchema } from "@/messaging/poc-rendezvous";
import type { PocRendezvousRequest } from "@/messaging/poc-rendezvous";
import { signalPath } from "@/p2p/downloads-rendezvous";
import { ProfileIdSchema } from "@/p2p/protocol";

/*
 * P3.1 (POC PLAN.md): the offscreen document's Downloads transport writes and erases through
 * here, since only the background holds chrome.downloads. It may touch this profile's signal
 * files only; the presence stays the alarm's.
 */

const SIGNAL_NAME = /^(offer|answer)-([0-9a-f-]{36})\.json$/;

export interface RelayDependencies {
  downloads: Pick<DownloadsPort, "download" | "search"> & DownloadsEraser;
  /** This profile's id. */
  me: () => Promise<string>;
  /** The namespace the presence joined, validated. */
  namespace: () => Promise<string>;
  boot: () => Promise<string>;
  root: () => Promise<string | null>;
}

interface Sender {
  id?: string;
  url?: string;
}

/** The path of this profile's signal file that `name` names, if it names one. */
function signalNamed(name: string, namespace: string, me: string): string | undefined {
  const [, kind, to] = SIGNAL_NAME.exec(name) ?? [];
  if ((kind !== "offer" && kind !== "answer") || !v.is(ProfileIdSchema, to)) return undefined;
  return signalPath(namespace, me, kind, to);
}

const isOwnSignal = (path: string, namespace: string, me: string) =>
  signalNamed(path.slice(path.lastIndexOf("/") + 1), namespace, me) === path;

/** Whether Chrome wrote this item at one of this profile's signal paths, in either separator. */
function isOwnItem(item: DownloadItem | undefined, namespace: string, me: string): boolean {
  const name = item?.filename.split(/[\\/]/).pop() ?? "";
  const path = signalNamed(name, namespace, me);
  if (!item || path === undefined) return false;
  return item.filename.replaceAll("\\", "/").endsWith(`/${path}`);
}

async function run(deps: RelayDependencies, request: PocRendezvousRequest): Promise<unknown> {
  const [namespace, me] = await Promise.all([deps.namespace(), deps.me()]);
  const writer = downloadsWriter(deps.downloads, deps.downloads);
  switch (request.op) {
    case "context":
      return { namespace, root: await deps.root() };
    case "boot":
      return deps.boot();
    case "write":
      if (!isOwnSignal(request.path, namespace, me)) {
        throw new Error(
          `Refusing ${JSON.stringify(request.path)}: not a signal file of this profile.`,
        );
      }
      return writer.write(request.path, request.text);
    case "erase": {
      const [item] = await deps.downloads.search({ id: request.id });
      if (!isOwnItem(item, namespace, me)) {
        throw new Error(
          `Refusing to erase download ${request.id}: not a signal file of this profile.`,
        );
      }
      return writer.erase(request.id);
    }
  }
}

/** A runtime.onMessage listener for the offscreen document's rendezvous requests only. */
export function createRendezvousRelay(
  deps: RelayDependencies,
  own: { extensionId: string; extensionUrl: string },
) {
  return (message: unknown, sender: Sender, reply: (answer: BackgroundReply) => void) => {
    const parsed = v.safeParse(PocRendezvousRequestSchema, message);
    const offscreen =
      sender.id === own.extensionId && sender.url === own.extensionUrl + OFFSCREEN_PAGE;
    if (!parsed.success || !offscreen) return false;
    run(deps, parsed.output).then(
      (result) => reply({ ok: true, result }),
      (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}
