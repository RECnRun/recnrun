import { CaptureCapabilitiesSchema } from "@recnrun/domain";
import type { Identity } from "@recnrun/domain";
import { useState } from "preact/hooks";
import * as v from "valibot";
import type { WorkspaceRequest, WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { OpenTab, TabSource } from "@/ports/tabs";
import { useBrowserTabs } from "@/views/use-browser-tabs";

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

/** The hosts typed into the field, split on commas and spaces, lowercased, once each. */
export function cookieHostsOf(text: string): string[] {
  const hosts = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((host) => host.toLowerCase());
  return [...new Set(hosts)];
}

function lastSaved({ lastCapture }: Identity): string {
  if (lastCapture === undefined) return "Not saved yet";
  return `Saved ${new Date(lastCapture.at).toLocaleString()}, ${approximateSize(lastCapture.bytes)}`;
}

/** An Incognito window, or a tab in the managed window, that RECnRun did not open. */
function hasConflict(status: WorkspaceStatus, tabs: readonly OpenTab[]): boolean {
  if (status.foreign.length > 0) return true;
  const { managed } = status;
  if (managed?.status !== "active") return false;
  return tabs.some(({ windowId, id }) => windowId === managed.windowId && id !== managed.tabId);
}

interface RowProps {
  identity: Identity;
  status: WorkspaceStatus;
  /** Commands that open or close windows wait; Delete never does. */
  blocked: boolean;
  disabled: boolean;
  run: (request: WorkspaceRequest) => void;
}

/** The one command a row offers for `identity` from where the workspace is, if any. */
function rowCommand(
  identity: Identity,
  status: WorkspaceStatus,
): { name: string; request: WorkspaceRequest } | undefined {
  const managed = status.managed?.status === "active" ? status.managed : undefined;
  const identityId = identity.id;
  if (managed === undefined) {
    return identity.lastCapture === undefined
      ? { name: "Switch to", request: { type: "workspace-switch", identityId } }
      : { name: "Resume", request: { type: "workspace-resume", identityId } };
  }
  // A window opened without an identity cannot be saved; Close and start empty replaces it.
  if (managed.identityId === undefined) return undefined;
  return managed.identityId === identityId
    ? { name: "Suspend", request: { type: "workspace-suspend" } }
    : { name: "Switch to", request: { type: "workspace-switch", identityId } };
}

function OpenAction({ identity, status, blocked, disabled, run }: RowProps) {
  const command = rowCommand(identity, status);
  if (command === undefined) return null;
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
      {open && <span class="identity-open">Open</span>}
      <span class="workspace-hint">{lastSaved(identity)}</span>
      {identity.capabilities.cookieHosts.length > 0 && (
        <span class="workspace-hint">
          Also keeps cookies of {identity.capabilities.cookieHosts.join(", ")}
        </span>
      )}
      <span class="identity-actions">
        <OpenAction {...props} />
        {!open && <DeleteAction {...props} />}
      </span>
    </li>
  );
}

function NewIdentity({
  target,
  disabled,
  run,
}: Pick<IdentitiesProps, "target" | "disabled" | "run">) {
  const [label, setLabel] = useState("");
  const [hosts, setHosts] = useState("");
  const capabilities = { cookieHosts: cookieHostsOf(hosts) };
  const valid = v.is(CaptureCapabilitiesSchema, capabilities);
  const create = () =>
    run({ type: "workspace-new-identity", label, url: target.trim(), capabilities });
  return (
    <div class="new-identity">
      <label class="workspace-address">
        Label
        <input value={label} onInput={(event) => setLabel(event.currentTarget.value)} />
      </label>
      <label class="workspace-address">
        Cookie hosts
        <input value={hosts} onInput={(event) => setHosts(event.currentTarget.value)} />
      </label>
      <p class={valid ? "workspace-hint" : "workspace-conflict"} role={valid ? undefined : "alert"}>
        {valid
          ? "Other hosts whose cookies the identity keeps, such as its sign-in provider."
          : "Cookie hosts are host names, such as sso.example.com."}
      </p>
      <button type="button" disabled={disabled || !valid} onClick={create}>
        New identity
      </button>
      <p class="workspace-hint">Saves the open identity first, then opens the address empty.</p>
    </div>
  );
}

interface IdentitiesProps {
  status: WorkspaceStatus;
  tabs: TabSource;
  /** The address a new identity opens. */
  target: string;
  disabled: boolean;
  run: (request: WorkspaceRequest) => void;
}

/** The saved identities, and the commands that save, open, and delete them. */
export function Identities({ status, tabs, target, disabled, run }: IdentitiesProps) {
  const open = useBrowserTabs(tabs)?.tabs ?? [];
  const blocked = hasConflict(status, open);
  return (
    <div class="identities">
      <h4>Saved identities</h4>
      <p class="workspace-hint">Saved on this computer in RECnRun, kept after Incognito closes.</p>
      {blocked && (
        <p class="workspace-conflict" role="status">
          Another Incognito window or tab is open. Close it to switch identities; RECnRun saves only
          its own tab.
        </p>
      )}
      <ul aria-label="Saved identities">
        {status.identities.map((identity) => (
          <IdentityRow
            key={identity.id}
            identity={identity}
            status={status}
            blocked={blocked || !status.access}
            disabled={disabled}
            run={run}
          />
        ))}
      </ul>
      {/* A new identity opens Incognito; without access the list still allows Delete. */}
      {status.access && <NewIdentity target={target} disabled={disabled || blocked} run={run} />}
    </div>
  );
}
