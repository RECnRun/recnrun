import type { Identity } from "@recnrun/domain";
import { useState } from "preact/hooks";
import type { PanelRequest } from "@/dashboard/workspace-alert";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** A capture's size as the dashboard shows it: approximate, in binary units. */
export function approximateSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `about ${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

function lastSaved({ lastCapture }: Identity): string {
  if (lastCapture === undefined) return "Not saved yet";
  return `Saved ${new Date(lastCapture.at).toLocaleString()}, ${approximateSize(lastCapture.bytes)}`;
}

interface RowProps {
  identity: Identity;
  status: WorkspaceStatus;
  /** Commands that open or close windows wait; Delete never does. */
  blocked: boolean;
  disabled: boolean;
  run: (request: PanelRequest) => void;
}

/** The command a row offers for `identity`: Close while it is open, Switch to otherwise. */
function rowCommand(identity: Identity, status: WorkspaceStatus) {
  const managed = status.managed?.status === "active" ? status.managed : undefined;
  const identityId = identity.id;
  if (managed?.identityId === identityId) {
    return { name: "Close", request: { type: "workspace-suspend" } } as const;
  }
  // With nothing open, a saved identity restores without saving another one first.
  if (managed === undefined && identity.lastCapture !== undefined) {
    return { name: "Switch to", request: { type: "workspace-resume", identityId } } as const;
  }
  return { name: "Switch to", request: { type: "workspace-switch", identityId } } as const;
}

function OpenAction({ identity, status, blocked, disabled, run }: RowProps) {
  const command = rowCommand(identity, status);
  return (
    <button type="button" disabled={disabled || blocked} onClick={() => run(command.request)}>
      {command.name}
    </button>
  );
}

/** Delete asks once more, since the saved data cannot come back. */
function DeleteAction({
  identity,
  disabled,
  run,
}: Pick<RowProps, "identity" | "disabled" | "run">) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" disabled={disabled} onClick={() => setAsking(true)}>
        Delete
      </button>
    );
  }
  const remove = () => run({ type: "workspace-delete-identity", identityId: identity.id });
  return (
    <>
      <span class="workspace-hint">Its saved data is removed from this computer.</span>
      <button type="button" disabled={disabled} onClick={remove}>
        Delete {identity.label}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Keep
      </button>
    </>
  );
}

function IdentityRow(props: RowProps) {
  const { identity, status } = props;
  const open = status.managed?.status === "active" && status.managed.identityId === identity.id;
  return (
    <li aria-label={identity.label} class="identity">
      <strong>{identity.label}</strong>
      {open ? (
        <span class="identity-open">Open</span>
      ) : (
        <span class="workspace-hint">{lastSaved(identity)}</span>
      )}
      <span class="identity-actions">
        <OpenAction {...props} />
        {!open && <DeleteAction {...props} />}
      </span>
    </li>
  );
}

/** The saved identities, and the commands that open, close, and delete them. */
export function Identities({ status, blocked, disabled, run }: Omit<RowProps, "identity">) {
  return (
    <div class="identities">
      <h4>Saved identities</h4>
      <p class="workspace-hint">Saved on this computer in RECnRun, kept after Incognito closes.</p>
      <ul aria-label="Saved identities">
        {status.identities.map((identity) => (
          <IdentityRow
            key={identity.id}
            identity={identity}
            status={status}
            blocked={blocked}
            disabled={disabled}
            run={run}
          />
        ))}
      </ul>
    </div>
  );
}
