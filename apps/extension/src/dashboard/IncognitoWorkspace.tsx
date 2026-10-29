import { errorMessage } from "@recnrun/domain";
import { useEffect, useRef, useState } from "preact/hooks";
import * as v from "valibot";
import { AddressField } from "@/dashboard/AddressField";
import { ask } from "@/dashboard/ask";
import { Identities } from "@/dashboard/Identities";
import { panelAlert } from "@/dashboard/workspace-alert";
import type { CommandFailure, PanelRequest } from "@/dashboard/workspace-alert";
import { WorkspaceConflict, hasConflict } from "@/dashboard/WorkspaceConflict";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { HistorySource } from "@/ports/history";
import type { OpenTab, TabSource } from "@/ports/tabs";
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

/**
 * The background's workspace status, read again when a window, a tab, the operation, or Site access
 * changes.
 */
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
    const unwatchSiteAccess = incognito.watchSiteAccess(reads.refresh);
    return () => {
      reads.stop();
      unwatchWindows();
      unwatchTabs();
      unwatchOperations();
      unwatchSiteAccess();
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
  /** Opens RECnRun's details in chrome://extensions, where Site access is. */
  openDetails: () => Promise<void>;
  history: HistorySource;
}

interface CommandProps {
  disabled: boolean;
  run: (request: PanelRequest) => void;
}

interface NewIdentityProps extends CommandProps {
  history: HistorySource;
  tabs: readonly OpenTab[];
  status: WorkspaceStatus;
}

function NewIdentity({ history, tabs, status, disabled, run }: NewIdentityProps) {
  const [target, setTarget] = useState("");
  return (
    <div class="new-identity">
      {/* The button sits beside the field, so the suggestions below it never cover the button. */}
      <div class="address-row">
        <AddressField
          value={target}
          onValue={setTarget}
          history={history}
          tabs={tabs}
          identities={status.identities}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => run({ type: "workspace-new-identity", url: target.trim() })}
        >
          New identity
        </button>
      </div>
      <p class="workspace-hint">
        Suggestions come from your normal tabs, saved identities, and history; only the address is
        copied, never cookies or storage.
      </p>
      <p class="workspace-hint">
        New identity saves the open identity first, then opens the address empty.
      </p>
    </div>
  );
}

/** Only Chrome may give Site access back, on RECnRun's details page. */
function SiteAccessWithheld({ openDetails }: { openDetails: () => void }) {
  return (
    <div class="workspace-requirement">
      <p>
        RECnRun saves every site's cookies with an identity, so it needs Site access “On all sites”.
        Set it in RECnRun's details.
      </p>
      <button type="button" onClick={openDetails}>
        Open RECnRun's details
      </button>
    </div>
  );
}

/** What the user must turn on in chrome://extensions before RECnRun opens a window. */
function Requirements({
  status,
  openDetails,
}: {
  status: WorkspaceStatus;
  openDetails: () => void;
}) {
  return (
    <>
      {!status.access && <p>The Incognito workspace requires “Allow in Incognito”.</p>}
      {!status.siteAccess && <SiteAccessWithheld openDetails={openDetails} />}
    </>
  );
}

type BodyProps = Pick<WorkspaceProps, "tabs" | "history"> &
  CommandProps & { status: WorkspaceStatus; openDetails: () => void };

function WorkspaceBody(props: BodyProps) {
  const { status, tabs, history, disabled, run, openDetails } = props;
  const open = useBrowserTabs(tabs)?.tabs ?? [];
  const granted = status.access && status.siteAccess;
  // Chrome hides Incognito windows without access, so only Delete stays possible then.
  const blocked = !granted || hasConflict(status, open);
  return (
    <>
      <Requirements status={status} openDetails={openDetails} />
      {granted && (
        <NewIdentity
          history={history}
          tabs={open}
          status={status}
          disabled={disabled || blocked}
          run={run}
        />
      )}
      {granted && blocked && (
        <WorkspaceConflict status={status} tabs={open} disabled={disabled} run={run} />
      )}
      <Identities status={status} blocked={blocked} disabled={disabled} run={run} />
    </>
  );
}

/**
 * The one Incognito window RECnRun manages, its saved identities, and what blocks switching. Every
 * command reads the status again when it ends, refused or not.
 */
export function IncognitoWorkspace(props: WorkspaceProps) {
  const { workspace, tabs, send, history, openDetails } = props;
  const { status, readError, refresh } = workspace;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CommandFailure>();
  const [dismissed, setDismissed] = useState<string>();
  const [detailsError, setDetailsError] = useState<string>();
  const details = () => {
    setDetailsError(undefined);
    openDetails().catch((caught: unknown) => setDetailsError(errorMessage(caught)));
  };
  const run = (request: PanelRequest) => {
    setPending(true);
    setFailure(undefined);
    setDismissed(status?.operation?.id);
    void ask(send, request)
      .catch((caught: unknown) => setFailure({ request, error: errorMessage(caught) }))
      .finally(() => {
        setPending(false);
        refresh();
      });
  };
  const alert = panelAlert({ status, dismissed, failure, readError }) ?? detailsError;
  return (
    <section class="incognito-workspace" aria-labelledby="incognito-workspace-heading">
      <h3 id="incognito-workspace-heading">Incognito workspace</h3>
      {alert !== undefined && (
        <p class="workspace-alert" role="alert">
          {alert}
        </p>
      )}
      {status && (
        <WorkspaceBody
          status={status}
          tabs={tabs}
          history={history}
          disabled={pending || status.busy}
          run={run}
          openDetails={details}
        />
      )}
    </section>
  );
}
