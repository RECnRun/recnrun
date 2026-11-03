import type { ReplayDriver } from "./driver.ts";
import type { Scope } from "./scope.ts";
import type { Deadline } from "./wait.ts";

/** What one running step works with: the driver, the run's values, and its own deadline. */
export interface StepContext {
  readonly driver: ReplayDriver;
  readonly scope: Scope;
  readonly deadline: Deadline;
}
