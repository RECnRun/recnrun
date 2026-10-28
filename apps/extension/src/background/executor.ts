import { errorMessage, toggled } from "@recnrun/domain";
import type { RecordingSession } from "@recnrun/domain";
import type { PeerChannel } from "@/background/peer-channel";
import { focusTab, startSession } from "@/background/session-requests";
import type { MessageOf, PeerMessage, SharedTabs } from "@/p2p/protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { BrowserTabs } from "@/ports/tabs";
import type { Repository } from "@/storage/peer-repository";

export interface ExecutorDependencies {
  channel: Pick<PeerChannel, "send">;
  session: RecordingStore;
  controller: Pick<Repository<{ profileId: string }>, "read" | "write">;
  /** This profile's tabs, as the dashboard lists them. */
  tabs: () => Promise<BrowserTabs>;
}

/** The tabs this profile shares: normal ones, without favicons; incognito ones never leave it. */
export async function sharedTabs(read: () => Promise<BrowserTabs>): Promise<SharedTabs> {
  const all = await read();
  const tabs = all.tabs
    .filter((tab) => !tab.incognito)
    .map(({ id, windowId, title, url }) => ({
      id,
      windowId,
      incognito: false as const,
      title,
      url,
    }));
  const shared = tabs.some((tab) => tab.id === all.currentId);
  return shared && all.currentId !== undefined ? { tabs, currentId: all.currentId } : { tabs };
}

/** The session here and which peer controls it, as the controller mirrors it. */
export async function sessionStatus(deps: Pick<ExecutorDependencies, "session" | "controller">) {
  const session = await deps.session.read();
  const controller = session ? await deps.controller.read() : null;
  return { session, controlledBy: controller?.profileId ?? null };
}

type Outcome = { ok: true } | { ok: false; reason: string };
const OK: Outcome = { ok: true };
const refused = (reason: string): Outcome => ({ ok: false, reason });
const TAB_CLOSED = "That tab is not open anymore.";

async function isShared(tabId: number, deps: ExecutorDependencies) {
  return (await sharedTabs(deps.tabs)).tabs.some((tab) => tab.id === tabId);
}

async function start(from: string, tabId: number, deps: ExecutorDependencies): Promise<Outcome> {
  const { session, controlledBy } = await sessionStatus(deps);
  // The session this peer started continues, as Continue does in a local dashboard.
  if (session && controlledBy !== from) return refused("A session already runs in that profile.");
  if (session && session.tabId !== tabId) return refused("That profile records another tab.");
  if (!(await isShared(tabId, deps))) return refused(TAB_CLOSED);
  // The marker goes first, so the report the new session triggers names its controller.
  if (!session) await deps.controller.write({ profileId: from });
  await startSession(tabId, deps.session).catch(async (error: unknown) => {
    if (!session) await deps.controller.write(null);
    throw error;
  });
  return OK;
}

async function change(
  from: string,
  deps: ExecutorDependencies,
  next: (session: RecordingSession) => RecordingSession | null,
): Promise<Outcome> {
  const { session, controlledBy } = await sessionStatus(deps);
  if (!session) return refused("No session runs in that profile.");
  if (controlledBy !== from) return refused("That session is controlled in its own profile.");
  const updated = next(session);
  if (updated === null) await deps.controller.write(null);
  await deps.session.write(updated);
  return OK;
}

async function activate(tabId: number, deps: ExecutorDependencies): Promise<Outcome> {
  if (!(await isShared(tabId, deps))) return refused(TAB_CLOSED);
  await focusTab(tabId);
  return OK;
}

type Command = MessageOf<"ACTIVATE_TAB" | "SESSION_START" | "SESSION_SET_STATUS" | "SESSION_STOP">;

function run(command: Command, deps: ExecutorDependencies): Promise<Outcome> {
  switch (command.type) {
    case "ACTIVATE_TAB":
      return activate(command.tabId, deps);
    case "SESSION_START":
      return start(command.from, command.tabId, deps);
    case "SESSION_STOP":
      return change(command.from, deps, () => null);
    case "SESSION_SET_STATUS":
      return change(command.from, deps, (session) =>
        session.status === command.status ? session : toggled(session, Date.now()),
      );
  }
}

const COMMANDS = new Set<PeerMessage["type"]>([
  "ACTIVATE_TAB",
  "SESSION_START",
  "SESSION_SET_STATUS",
  "SESSION_STOP",
]);
const isCommand = (message: PeerMessage): message is Command => COMMANDS.has(message.type);

/** Answers what the peer asks of this profile's tabs and session; ignores everything else. */
export async function execute(message: PeerMessage, deps: ExecutorDependencies): Promise<void> {
  const { channel } = deps;
  const requestId = message.id;
  if (message.type === "GET_TABS")
    await channel.send("TABS_SNAPSHOT", { requestId, ...(await sharedTabs(deps.tabs)) });
  // A new link starts with the session's state, so the controller never keeps a stale copy.
  if (message.type === "HELLO")
    await channel.send("SESSION_STATUS", { requestId, ...(await sessionStatus(deps)) });
  if (!isCommand(message)) return;
  const outcome = await run(message, deps).catch((error: unknown) =>
    refused(errorMessage(error).slice(0, 200)),
  );
  await channel.send("COMMAND_RESULT", { requestId, ...outcome });
}
