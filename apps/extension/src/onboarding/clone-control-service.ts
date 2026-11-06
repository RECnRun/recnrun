import { errorMessage } from "@recnrun/domain";
import { readCloneStatus, readClones } from "@/p2p/clone-control";
import { readRegistry } from "@/p2p/registry";
import type { CloneAction, CloneRow } from "@/p2p/clone-control";

export const POLL_MS = 2000;
/** Longer than a launcher pass and a stop: past it the request is given up as unanswered. */
export const NO_ANSWER_MS = 120_000;

interface Texts {
  clones?: string;
  status?: string;
  registry?: string;
}

export interface CloneControlPorts {
  /** The text of control/clones.json and of the request's status.json; undefined when unreadable. */
  readTexts: (requestId: string | undefined) => Promise<Texts>;
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

/** A clone the launcher lists; linked when the registry shows the boot it reported. */
export type CloneEntry = CloneRow & { linked: boolean };

export interface Outcome {
  state: "done" | "refused" | "error" | "unanswered";
  message: string;
}

export interface CloneControlSnapshot {
  clones: CloneEntry[];
  pending?: Pending;
  /** The last terminal answer, kept structured so the panel can alert on a failure. */
  outcome?: Outcome;
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
    core.state.outcome = { state: answer.state, message: answer.message };
    core.state.pending = undefined;
  } else if ((ports.now ?? Date.now)() - core.state.askedAt > NO_ANSWER_MS) {
    core.state.message = "No answer from the launcher.";
    core.state.outcome = { state: "unanswered", message: core.state.message };
    core.state.pending = undefined;
  }
}

async function refresh(core: Core, ports: CloneControlPorts): Promise<void> {
  const texts = await ports.readTexts(core.state.pending?.requestId).catch((): Texts => ({}));
  const rows = readClones(texts.clones)?.clones;
  if (rows) {
    const peers = readRegistry(texts.registry, undefined, (ports.now ?? Date.now)()).publication
      ?.peers;
    core.state.clones = rows.map((row) => ({
      ...row,
      linked: row.boot !== "" && peers?.[row.instanceId]?.boot === row.boot,
    }));
  }
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
      core.state.failure = "";
      core.state.message = "";
      core.state.outcome = undefined;
      core.state.pending = { requestId, action, instanceId };
      core.state.askedAt = (ports.now ?? Date.now)();
      core.emit();
      try {
        await ports.send({ type: "POC_CLONE_CONTROL", choice: { requestId, action, instanceId } });
      } catch (error) {
        core.state.pending = undefined;
        core.state.failure = errorMessage(error);
        core.emit();
      }
    },
  };
}
