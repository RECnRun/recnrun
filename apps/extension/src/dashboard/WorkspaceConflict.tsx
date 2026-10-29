import type { PanelRequest } from "@/dashboard/workspace-alert";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { OpenTab } from "@/ports/tabs";

/**
 * An Incognito window open while no identity is: no identity owns its tabs. While one is open,
 * every Incognito tab and window is its session, which a switch saves, so none conflicts.
 */
export function hasConflict(status: WorkspaceStatus): boolean {
  return status.foreign.length > 0;
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
  const notice =
    windowIds.length === 1
      ? "An Incognito window is open while no identity is, so no identity owns it. Close it to switch identities."
      : "Incognito windows are open while no identity is, so no identity owns them. Close them to switch identities.";
  return (
    <div class="workspace-conflict" role="status">
      <p>{notice}</p>
      <ForeignWindows status={status} tabs={tabs} />
      <button
        type="button"
        disabled={disabled}
        onClick={() => run({ type: "workspace-close-windows", windowIds })}
      >
        Close these windows
      </button>
    </div>
  );
}
