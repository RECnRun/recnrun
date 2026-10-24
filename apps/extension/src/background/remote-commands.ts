import type { RecordingSession } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { focus, startSession } from "@/background/session-requests";
import type { SessionStore } from "@/background/session-requests";
import type { PeerChannel } from "@/background/peer-channel";
import type { PeerMessage, RemoteTab } from "@/p2p/protocol";
import type { Repository } from "@/storage/peer-repository";
import { toBrowserTabs } from "@/tabs/open-tabs";
import { toggled } from "@/views/recording";

export interface ExecutorDependencies {
  channel: Pick<PeerChannel, "send">;
  session: SessionStore;
  controller: Pick<Repository<{ profileId: string }>, "read" | "write">;
}

/** The tabs this profile shares: normal ones only, since incognito titles never leave it. */
export async function sharedTabs(): Promise<{ tabs: RemoteTab[]; currentId?: number }> {
  const all = toBrowserTabs(
    await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }),
  );
  const tabs = all.tabs
    .filter((tab) => !tab.incognito)
    .map(({ id, windowId, title, url }) => ({
      id,
      windowId,
      incognito: false as const,
      title,
      url,
    }));
  const current = tabs.some((tab) => tab.id === all.currentId) ? all.currentId : undefined;
  return current === undefined ? { tabs } : { tabs, currentId: current };
}

async function isShared(tabId: number): Promise<boolean> {
  return (await sharedTabs()).tabs.some((tab) => tab.id === tabId);
}

/** The session here and which peer controls it, as the controller mirrors it. */
export async function sessionStatus(deps: Omit<ExecutorDependencies, "channel">) {
  const session = await deps.session.read().catch(() => null);
  const controller = session ? await deps.controller.read() : null;
  return { session, controlledBy: controller?.profileId ?? null };
}

type Outcome = { ok: true } | { ok: false; reason: string };
const refused = (reason: string): Outcome => ({ ok: false, reason });
const OK: Outcome = { ok: true };

async function startFor(from: string, tabId: number, deps: ExecutorDependencies): Promise<Outcome> {
  const { session, controlledBy } = await sessionStatus(deps);
  // A session this peer already controls continues, as Continue does locally.
  if (session && controlledBy !== from) return refused("A session already runs in that profile.");
  if (!session && !(await isShared(tabId))) return refused("That tab is not open anymore.");
  if (!session) await deps.controller.write({ profileId: from });
  await startSession(tabId, deps.session);
  return OK;
}

async function changeFor(
  from: string,
  deps: ExecutorDependencies,
  change: (session: RecordingSession) => RecordingSession | null,
): Promise<Outcome> {
  const { session, controlledBy } = await sessionStatus(deps);
  if (!session) return refused("No session runs in that profile.");
  if (controlledBy !== from) return refused("That session is controlled elsewhere.");
  const next = change(session);
  await deps.session.write(next);
  if (next === null) await deps.controller.write(null);
  return OK;
}

async function activate(tabId: number): Promise<Outcome> {
  if (!(await isShared(tabId))) return refused("That tab is not open anymore.");
  await focus(tabId);
  return OK;
}

function commandOutcome(
  message: PeerMessage,
  deps: ExecutorDependencies,
): Promise<Outcome> | undefined {
  if (message.type === "ACTIVATE_TAB") return activate(message.tabId);
  if (message.type === "SESSION_START") return startFor(message.from, message.tabId, deps);
  if (message.type === "SESSION_STOP") return changeFor(message.from, deps, () => null);
  if (message.type !== "SESSION_SET_STATUS") return undefined;
  const { status } = message;
  return changeFor(message.from, deps, (session) =>
    session.status === status ? session : toggled(session, Date.now()),
  );
}

/** Answers what the peer asks of this profile's tabs and session; ignores everything else. */
export async function executeRemote(
  message: PeerMessage,
  deps: ExecutorDependencies,
): Promise<void> {
  const { channel } = deps;
  if (message.type === "PING") {
    await channel.send("PONG", { requestId: message.id, timestamp: Date.now() });
  } else if (message.type === "GET_TABS") {
    await channel.send("TABS_SNAPSHOT", { requestId: message.id, ...(await sharedTabs()) });
  } else if (message.type === "GET_SESSION" || message.type === "HELLO") {
    await channel.send("SESSION_STATUS", { requestId: message.id, ...(await sessionStatus(deps)) });
  }
  const outcome = commandOutcome(message, deps);
  if (!outcome) return;
  const result = await outcome.catch((error: unknown) =>
    refused(error instanceof Error ? error.message : "The command failed."),
  );
  await channel.send("COMMAND_RESULT", { requestId: message.id, ...result });
}
