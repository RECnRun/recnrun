/** A failed step of the agent's work and an error name; the message never carries a stored value. */
export class OriginFailure extends Error {
  constructor(step: string, reason: string) {
    super(`${step}: ${reason}`);
    this.name = "OriginFailure";
  }
}

/** Runs one step, turning whatever it throws into an `OriginFailure` that names only the step. */
export async function step<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OriginFailure) throw error;
    // DOMException messages may quote keys, so only the name leaves the page.
    throw new OriginFailure(name, error instanceof Error ? error.name : "UnknownError");
  }
}
