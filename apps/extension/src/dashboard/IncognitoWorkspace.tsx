import { errorMessage } from "@recnrun/domain";
import { useEffect, useRef, useState } from "preact/hooks";
import * as v from "valibot";
import { ask } from "@/dashboard/ask";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import type { WorkspaceRequest, WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { TabSource } from "@/ports/tabs";
import { coalesceReads } from "@/views/coalesce-reads";
import type { ExtensionServices, SendRequest } from "@/views/extension-services";
import { useBrowserTabs } from "@/views/use-browser-tabs";

type StatusRead = { status: WorkspaceStatus } | { error: string };

/** The workspace status as the dashboard last read it, and how to read it again. */
export interface WorkspaceRead {
  status: WorkspaceStatus | undefined;
  readError: string | undefined;
  refresh: () => void;
}

type StatusSources = Pick<ExtensionServices, "incognito" | "tabs" | "send" | "operations">;

/** The background's workspace status, read again when a window, a tab, or the operation changes. */
export function useWorkspaceStatus({
  incognito,
  tabs,
  send,
  operations,
}: StatusSources): WorkspaceRead {
  const [read, setRead] = useState<StatusRead>();
  const refresh = useRef(() => {});
  useEffect(() => {
    const reads = coalesceReads(
      () =>
        ask(send, { type: "workspace-status" })
          .then((result): StatusRead => ({ status: v.parse(WorkspaceStatusSchema, result) }))
          .catch((caught: unknown): StatusRead => ({ error: errorMessage(caught) })),
      setRead,
    );
    refresh.current = reads.refresh;
    reads.refresh();
    const unwatchWindows = incognito.watchWindows(reads.refresh);
    const unwatchTabs = tabs.watch(reads.refresh);
    const unwatchOperations = operations.watch(reads.refresh);
    return () => {
      reads.stop();
      unwatchWindows();
      unwatchTabs();
      unwatchOperations();
    };
  }, [incognito, tabs, send, operations]);
  return {
    status: read && "status" in read ? read.status : undefined,
    readError: read && "error" in read ? read.error : undefined,
    refresh: () => refresh.current(),
  };
}

/** The tab RECnRun may record: the managed window's, while that window is open. */
export function managedTabId(status: WorkspaceStatus | undefined): number | undefined {
  const managed = status?.managed;
  return managed?.status === "active" ? managed.tabId : undefined;
}

interface WorkspaceProps {
  workspace: WorkspaceRead;
  tabs: TabSource;
  send: SendRequest;
  /** The address the workspace opens, which a normal tab in the list may also supply. */
  target: string;
  onTarget: (url: string) => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The other Incognito windows; their titles come from the live tab model and are never stored. */
function ForeignWindows({ status, tabs }: { status: WorkspaceStatus; tabs: TabSource }) {
  const open = useBrowserTabs(tabs)?.tabs ?? [];
  const { foreign } = status;
  const are = foreign.length === 1 ? "is" : "are";
  return (
    <>
      <p>
        {plural(foreign.length, "Incognito window", "Incognito windows")} {are} open
      </p>
      <ul class="incognito-windows">
        {foreign.map(({ id, tabCount }) => {
          const titles = open.filter((tab) => tab.windowId === id).map((tab) => tab.title);
          const count = plural(tabCount, "tab", "tabs");
          return <li key={id}>{titles.length > 0 ? `${count}: ${titles.join(", ")}` : count}</li>;
        })}
      </ul>
    </>
  );
}

interface ActionProps {
  status: WorkspaceStatus;
  target: string;
  disabled: boolean;
  run: (request: WorkspaceRequest) => void;
}

/** One action per state: restart the open workspace, close the windows shown, or start; none while both are open. */
function WorkspaceAction({ status, target, disabled, run }: ActionProps) {
  const url = target.trim();
  // Both commands need every other Incognito window gone; RECnRun closes none it did not open here.
  if (status.managed?.status === "active" && status.foreign.length > 0) {
    return (
      <>
        <p>Incognito workspace open</p>
        <p class="workspace-hint">
          Close the other Incognito windows yourself; this list follows them.
        </p>
      </>
    );
  }
  if (status.managed?.status === "active") {
    return (
      <>
        <p>Incognito workspace open</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => run({ type: "workspace-restart", url })}
        >
          Close and start empty
        </button>
        <p class="workspace-hint">Its current Incognito data is discarded.</p>
      </>
    );
  }
  if (status.foreign.length > 0) {
    const windowIds = status.foreign.map(({ id }) => id);
    return (
      <>
        <button
          type="button"
          disabled={disabled}
          onClick={() => run({ type: "workspace-close-and-start", url, windowIds })}
        >
          Close these windows and start
        </button>
        <p class="workspace-hint">Or close them yourself; this list follows them.</p>
      </>
    );
  }
  return (
    <button type="button" disabled={disabled} onClick={() => run({ type: "workspace-start", url })}>
      Start
    </button>
  );
}

function AddressField({ target, onTarget }: Pick<WorkspaceProps, "target" | "onTarget">) {
  return (
    <>
      <label class="workspace-address">
        Address
        <input
          type="url"
          value={target}
          placeholder="https://"
          onInput={(event) => onTarget(event.currentTarget.value)}
        />
      </label>
      <p class="workspace-hint">
        “Use this tab's address” copies only a normal tab's address, never its cookies or storage.
      </p>
    </>
  );
}

interface BodyProps extends ActionProps {
  tabs: TabSource;
  onTarget: (url: string) => void;
}

function WorkspaceBody({ status, tabs, target, onTarget, disabled, run }: BodyProps) {
  if (!status.access) return <p>The Incognito workspace requires “Allow in Incognito”.</p>;
  return (
    <>
      <AddressField target={target} onTarget={onTarget} />
      {status.foreign.length > 0 && <ForeignWindows status={status} tabs={tabs} />}
      <WorkspaceAction
        status={status}
        target={target}
        disabled={disabled || status.busy}
        run={run}
      />
    </>
  );
}

/** Why the last start with an identity stopped, kept until another command runs. */
function failedStart(status: WorkspaceStatus | undefined): string | undefined {
  const operation = status?.operation;
  if (operation?.status !== "failed") return undefined;
  return `Start with an identity failed at the ${operation.step} step. ${operation.error ?? ""}`;
}

/**
 * The one Incognito window RECnRun manages: what blocks it, and the command for each state. Every
 * command reads the status again when it ends, refused or not.
 */
export function IncognitoWorkspace({ workspace, tabs, send, target, onTarget }: WorkspaceProps) {
  const { status, readError, refresh } = workspace;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = (request: WorkspaceRequest) => {
    setPending(true);
    setError(undefined);
    void ask(send, request)
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => {
        setPending(false);
        refresh();
      });
  };
  const shown = error ?? readError;
  const failed = failedStart(status);
  return (
    <section class="incognito-workspace" aria-labelledby="incognito-workspace-heading">
      <h3 id="incognito-workspace-heading">Incognito workspace</h3>
      {status && (
        <WorkspaceBody
          status={status}
          tabs={tabs}
          target={target}
          onTarget={onTarget}
          disabled={pending}
          run={run}
        />
      )}
      {failed && <p role="alert">{failed}</p>}
      {shown && <p role="alert">{shown}</p>}
    </section>
  );
}
