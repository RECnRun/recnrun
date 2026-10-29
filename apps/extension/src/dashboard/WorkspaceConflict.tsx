import type { PanelRequest } from "@/dashboard/workspace-alert";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { OpenTab } from "@/ports/tabs";

/** An Incognito window, or a tab in the managed window, that RECnRun did not open. */
export function hasConflict(status: WorkspaceStatus, tabs: readonly OpenTab[]): boolean {
  if (status.foreign.length > 0) return true;
  const { managed } = status;
  if (managed?.status !== "active") return false;
  return tabs.some(({ windowId, id }) => windowId === managed.windowId && id !== managed.tabId);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The other Incognito windows; their titles come from the live tab model and are never stored. */
function ForeignWindows({ status, tabs }: { status: WorkspaceStatus; tabs: readonly OpenTab[] }) {
  const { foreign } = status;
  const are = foreign.length === 1 ? "is" : "are";
  return (
    <>
      <p>
        {plural(foreign.length, "Incognito window", "Incognito windows")} {are} open
      </p>
      <ul class="incognito-windows">
        {foreign.map(({ id, tabCount }) => {
          const titles = tabs.filter((tab) => tab.windowId === id).map((tab) => tab.title);
          const count = plural(tabCount, "tab", "tabs");
          return <li key={id}>{titles.length > 0 ? `${count}: ${titles.join(", ")}` : count}</li>;
        })}
      </ul>
    </>
  );
}

interface ConflictProps {
  status: WorkspaceStatus;
  tabs: readonly OpenTab[];
  disabled: boolean;
  run: (request: PanelRequest) => void;
}

/** What blocks switching, and the windows RECnRun may close: exactly the ones listed. */
export function WorkspaceConflict({ status, tabs, disabled, run }: ConflictProps) {
  const windowIds = status.foreign.map(({ id }) => id);
  return (
    <div class="workspace-conflict" role="status">
      <p>
        Another Incognito window or tab is open. Close it to switch identities; RECnRun saves only
        its own tab.
      </p>
      {windowIds.length > 0 && (
        <>
          <ForeignWindows status={status} tabs={tabs} />
          <button
            type="button"
            disabled={disabled}
            onClick={() => run({ type: "workspace-close-windows", windowIds })}
          >
            Close these windows
          </button>
        </>
      )}
    </div>
  );
}
