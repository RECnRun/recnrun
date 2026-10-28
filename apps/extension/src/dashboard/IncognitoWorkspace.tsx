import { errorMessage } from "@recnrun/domain";
import { useEffect, useRef, useState } from "preact/hooks";
import * as v from "valibot";
import { ask } from "@/dashboard/ask";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import type { WorkspaceRequest, WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { IncognitoAccess, TabSource } from "@/ports/tabs";
import { coalesceReads } from "@/views/coalesce-reads";
import type { SendRequest } from "@/views/extension-services";
import { useBrowserTabs } from "@/views/use-browser-tabs";

interface WorkspaceProps {
  access: IncognitoAccess;
  tabs: TabSource;
  send: SendRequest;
  /** The address the workspace opens, which a normal tab in the list may also supply. */
  target: string;
  onTarget: (url: string) => void;
}

type StatusRead = { status: WorkspaceStatus } | { error: string };

/** The background's workspace status, read again when a window or tab comes or goes. */
function useWorkspaceStatus({ access, tabs, send }: Omit<WorkspaceProps, "target" | "onTarget">) {
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
    const unwatchWindows = access.watchWindows(reads.refresh);
    const unwatchTabs = tabs.watch(reads.refresh);
    return () => {
      reads.stop();
      unwatchWindows();
      unwatchTabs();
    };
  }, [access, tabs, send]);
  return {
    status: read && "status" in read ? read.status : undefined,
    readError: read && "error" in read ? read.error : undefined,
    refresh: () => refresh.current(),
  };
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

/** One action per state: restart the open workspace, close the windows shown, or start. */
function WorkspaceAction({ status, target, disabled, run }: ActionProps) {
  const url = target.trim();
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

/**
 * The one Incognito window RECnRun manages: what blocks it, and the command for each state. Every
 * command reads the status again when it ends, refused or not.
 */
export function IncognitoWorkspace({ target, onTarget, ...sources }: WorkspaceProps) {
  const { status, readError, refresh } = useWorkspaceStatus(sources);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = (request: WorkspaceRequest) => {
    setPending(true);
    setError(undefined);
    void ask(sources.send, request)
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => {
        setPending(false);
        refresh();
      });
  };
  const shown = error ?? readError;
  return (
    <section class="incognito-workspace" aria-labelledby="incognito-workspace-heading">
      <h3 id="incognito-workspace-heading">Incognito workspace</h3>
      {status && (
        <WorkspaceBody
          status={status}
          tabs={sources.tabs}
          target={target}
          onTarget={onTarget}
          disabled={pending}
          run={run}
        />
      )}
      {shown && <p role="alert">{shown}</p>}
    </section>
  );
}
