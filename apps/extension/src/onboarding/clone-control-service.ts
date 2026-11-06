import { errorMessage } from "@recnrun/domain";
import { readCloneStatus, readClones } from "@/p2p/clone-control";
import type { CloneAction, CloneRow } from "@/p2p/clone-control";

export const POLL_MS = 2000;
/** Longer than a launcher pass and a stop: past it the request is given up as unanswered. */
export const NO_ANSWER_MS = 120_000;

export interface CloneControlPorts {
  /** The text of control/clones.json and of the request's status.json; undefined when unreadable. */
  readTexts: (requestId: string | undefined) => Promise<{ clones?: string; status?: string }>;
  /** Asks the background to write the request; rejects with the reason. */
  send: (message: unknown) => Promise<void>;
  /** Whether this profile is the master, the only role that controls clones. */
  master: () => Promise<boolean>;
  newId: () => string;
  every: (run: () => void, ms: number) => () => void;
  now?: () => number;
}

export interface Pending {
  requestId: string;
  action: CloneAction;
  instanceId: string;
}

export interface CloneControlSnapshot {
  clones: CloneRow[];
  pending?: Pending;
  /** The launcher's last answer, as "<state>: <message>". */
  message: string;
  /** Why the last request could not be written, if it could not. */
  failure: string;
}

export interface CloneControl {
  isMaster: () => Promise<boolean>;
  /** Calls `listener` on every change and keeps the files polled until the returned stop. */
  watch: (listener: (snapshot: CloneControlSnapshot) => void) => () => void;
  ask: (instanceId: string, action: CloneAction) => Promise<void>;
}

/** The folded state and who listens to it. */
function createCore() {
  const state: CloneControlSnapshot & { askedAt: number } = {
    clones: [],
    message: "",
    failure: "",
    askedAt: 0,
  };
  const listeners = new Set<(snapshot: CloneControlSnapshot) => void>();
  const emit = () => {
    const { askedAt: _askedAt, ...snapshot } = state;
    listeners.forEach((listener) => listener(snapshot));
  };
  return { state, listeners, emit };
}

type Core = ReturnType<typeof createCore>;

/** Every terminal answer, or the lack of one, ends the pending request. */
function settle(core: Core, ports: CloneControlPorts, status: string | undefined): void {
  const pending = core.state.pending;
  if (!pending) return;
  const answer = readCloneStatus(status);
  if (answer && answer.requestId === pending.requestId && answer.state !== "running") {
    core.state.message = `${answer.state}: ${answer.message}`;
    core.state.pending = undefined;
  } else if ((ports.now ?? Date.now)() - core.state.askedAt > NO_ANSWER_MS) {
    core.state.message = "No answer from the launcher.";
    core.state.pending = undefined;
  }
}

async function refresh(core: Core, ports: CloneControlPorts): Promise<void> {
  const texts = await ports
    .readTexts(core.state.pending?.requestId)
    .catch((): { clones?: string; status?: string } => ({}));
  core.state.clones = readClones(texts.clones)?.clones ?? core.state.clones;
  settle(core, ports, texts.status);
  core.emit();
}

export function createCloneControl(ports: CloneControlPorts): CloneControl {
  const core = createCore();
  let stopPolling: (() => void) | undefined;
  const stop = () => {
    stopPolling?.();
    stopPolling = undefined;
  };
  return {
    isMaster: () => ports.master().catch(() => false),
    watch: (listener) => {
      core.listeners.add(listener);
      if (core.listeners.size === 1) {
        stopPolling ??= ports.every(() => void refresh(core, ports), POLL_MS);
        void refresh(core, ports);
      } else {
        refresh(core, ports).catch(() => {});
      }
      return () => {
        core.listeners.delete(listener);
        if (core.listeners.size === 0) stop();
      };
    },
    ask: async (instanceId, action) => {
      if (core.state.pending) return;
      const requestId = ports.newId();
      try {
        await ports.send({ type: "POC_CLONE_CONTROL", choice: { requestId, action, instanceId } });
      } catch (error) {
        core.state.failure = errorMessage(error);
        core.emit();
        return;
      }
      core.state.failure = "";
      core.state.message = "";
      core.state.pending = { requestId, action, instanceId };
      core.state.askedAt = (ports.now ?? Date.now)();
      core.emit();
    },
  };
}
