import { createCdpAdapter } from "@recnrun/adapter";
import { createEngine, type Engine } from "@recnrun/engine";
import { flowFolderLayout, type FlowFolderLayout } from "@recnrun/persistence";

export interface ServiceDependencies {
  engine: Engine;
  persistence: FlowFolderLayout;
}

export interface Health {
  ok: true;
  version: number;
}

export interface Service {
  health(): Health;
}

/** Creates the service over injected parts, so tests can pass fakes. */
export function createService({ engine }: ServiceDependencies): Service {
  return { health: () => ({ ok: true, version: engine.version }) };
}

/** Creates the service the CLI starts: the engine over the CDP adapter. */
export function createLocalService(): Service {
  return createService({
    engine: createEngine(createCdpAdapter()),
    persistence: flowFolderLayout,
  });
}

// The CLI and tests/contract compile this source with their own `@/`, so it imports itself with `./`.
export { EgressForbiddenError } from "./egress.ts";
export {
  startService,
  type RunningService,
  type ServiceOptions,
  type StartResult,
} from "./service.ts";
export { stopOnSignals } from "./signals.ts";
