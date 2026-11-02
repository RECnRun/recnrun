import {
  type CapabilityMatrix,
  type DiscoveryResult,
  PROTOCOL_SCHEMA_VERSION,
  type ProfileBinding,
} from "@recnrun/protocol";
import type { Api } from "@/api/api";
import type { Result } from "@/api/commands";
import { useLoad } from "@/api/context";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState, Loadable } from "@/ui/States";

export const REMOTE_DEBUGGING_GUIDANCE =
  "Enable remote debugging at chrome://inspect/#remote-debugging, then check again.";

const DISCOVERY_LABELS = {
  "missing-file": "Not found",
  "malformed-file": "Unreadable",
  "stale-file": "Not answering",
} as const;

type Doctor = {
  health: Result<"health">;
  profiles: ProfileBinding[];
  capabilities: CapabilityMatrix;
};

async function loadDoctor(api: Api): Promise<Doctor> {
  const [health, list, capabilities] = await Promise.all([
    api.call("health", {}),
    api.call("profiles.list", {}),
    api.call("capabilities.get", {}),
  ]);
  return { health, profiles: list.profiles, capabilities };
}

function Connection({ chrome }: { chrome: DiscoveryResult }) {
  if (chrome.ok) {
    return (
      <p>
        <Badge tone="success">Connected</Badge> Chrome answers on port {chrome.port} for{" "}
        <code>{chrome.userDataDir}</code>.
      </p>
    );
  }
  return (
    <>
      <p>
        <Badge tone="danger">{DISCOVERY_LABELS[chrome.code]}</Badge> {chrome.remedy}
      </p>
      <p>{REMOTE_DEBUGGING_GUIDANCE}</p>
    </>
  );
}

function Bindings({ profiles, chrome }: { profiles: ProfileBinding[]; chrome: DiscoveryResult }) {
  if (profiles.length === 0) return <EmptyState>No profile bindings yet.</EmptyState>;
  return (
    <ul class="list">
      {profiles.map((binding) => {
        const fresh = chrome.ok && chrome.wsEndpoint === binding.wsEndpoint;
        return (
          <li key={binding.name}>
            <strong>{binding.name}</strong> <span class="muted">{binding.chrome}</span>{" "}
            <Badge tone={fresh ? "success" : "danger"}>{fresh ? "Fresh" : "Stale"}</Badge>
          </li>
        );
      })}
    </ul>
  );
}

function Versions({ doctor }: { doctor: Doctor }) {
  const all = doctor.capabilities.capabilities;
  const implemented = all.filter((entry) => entry.status === "implemented").length;
  return (
    <dl class="facts">
      <dt>Service</dt>
      <dd>{doctor.health.serviceVersion}</dd>
      <dt>Service protocol</dt>
      <dd>{doctor.health.protocolVersion}</dd>
      <dt>UI protocol</dt>
      <dd>{PROTOCOL_SCHEMA_VERSION}</dd>
      <dt>Capabilities</dt>
      <dd>
        {implemented} of {all.length} implemented
      </dd>
    </dl>
  );
}

/** Setup and doctor: whether Chrome is reachable, the profile bindings, and the versions. */
export function Setup() {
  const { loaded, reload } = useLoad(loadDoctor, "doctor");
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {(doctor) => (
        <div class="stack">
          <Card title="Chrome" actions={<Button onClick={reload}>Check again</Button>}>
            <Connection chrome={doctor.health.chrome} />
          </Card>
          <Card title="Bindings">
            <Bindings profiles={doctor.profiles} chrome={doctor.health.chrome} />
          </Card>
          <Card title="Versions">
            <Versions doctor={doctor} />
          </Card>
        </div>
      )}
    </Loadable>
  );
}
