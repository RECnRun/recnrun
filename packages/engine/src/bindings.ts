import type {
  BindingChange,
  BindingClassification,
  BrowserHandshake,
  DiscoveryResult,
  Flow,
  ProfileBinding,
  Step,
} from "@recnrun/protocol";

/** Another binding already holds the candidate's endpoint or profile folder. */
export interface BindingConflict {
  existing: string;
  field: "wsEndpoint" | "userDataDir";
}

export type ActorResolution =
  | { ok: true; bindings: Record<string, string> }
  | { ok: false; code: "missing-binding"; actor: string; message: string };

const ENDPOINT_PATH = "/devtools/browser/";

// A folder typed with or without its trailing separator is the same profile.
const folder = (path: string): string => path.replace(/[\\/]+$/, "");

const endpointPath = (wsEndpoint: string): string =>
  wsEndpoint.slice(wsEndpoint.indexOf(ENDPOINT_PATH));

/** Finds a binding with another name that already holds the candidate's endpoint or folder. */
export function detectDuplicateBinding(
  bindings: readonly ProfileBinding[],
  candidate: Pick<ProfileBinding, "name" | "wsEndpoint" | "userDataDir">,
): BindingConflict | undefined {
  const others = bindings.filter(({ name }) => name !== candidate.name);
  const sameEndpoint = others.find(({ wsEndpoint }) => wsEndpoint === candidate.wsEndpoint);
  if (sameEndpoint) return { existing: sameEndpoint.name, field: "wsEndpoint" };
  const sameFolder = others.find(
    ({ userDataDir }) => folder(userDataDir) === folder(candidate.userDataDir),
  );
  return sameFolder && { existing: sameFolder.name, field: "userDataDir" };
}

/**
 * Compares a stored binding with what discovery (and the handshake, once connected) finds now.
 * A restarted Chrome answers on a new browser path; the caller reports it and asks the user to
 * reconfirm, never rebinding by itself.
 */
export function classifyBinding(
  binding: ProfileBinding,
  discovered: DiscoveryResult,
  handshake?: BrowserHandshake,
): BindingClassification {
  if (!discovered.ok) return { status: "stale-missing", remedy: discovered.remedy };
  const changed: BindingChange[] = [];
  if (discovered.path !== endpointPath(binding.wsEndpoint)) changed.push("endpoint");
  if (handshake && handshake.version.product !== binding.chrome) changed.push("chrome");
  const { wsEndpoint } = discovered;
  return changed.length === 0
    ? { status: "fresh", wsEndpoint }
    : { status: "stale-restarted", wsEndpoint, changed };
}

function* stepActors(steps: readonly Step[]): Generator<string> {
  for (const step of steps) {
    if (step.actor) yield step.actor;
    if ("steps" in step) yield* stepActors(step.steps);
    if ("otherwise" in step && step.otherwise) yield* stepActors(step.otherwise);
  }
}

/** Maps each actor the flow declares or uses to the binding name chosen for it. */
export function resolveActorBindings(
  flow: Flow,
  bindingByActor: Readonly<Record<string, string>>,
): ActorResolution {
  const bindings: Record<string, string> = {};
  for (const actor of new Set([...Object.keys(flow.actors), ...stepActors(flow.steps)])) {
    const name = Object.hasOwn(bindingByActor, actor) ? bindingByActor[actor] : undefined;
    if (name === undefined) {
      const message = `The actor "${actor}" has no profile binding; choose one before running the flow.`;
      return { ok: false, code: "missing-binding", actor, message };
    }
    bindings[actor] = name;
  }
  return { ok: true, bindings };
}
