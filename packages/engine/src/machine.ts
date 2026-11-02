/** Next state per state and event; an event a state does not list is illegal there. */
export type TransitionTable<S extends string, E extends string> = Readonly<
  Record<S, Readonly<Partial<Record<E, S>>>>
>;

/** An event the machine's current state does not accept. */
export interface IllegalTransition {
  code: "illegal-transition";
  machine: string;
  from: string;
  event: string;
}

export type Transition<S extends string> =
  | { ok: true; state: S }
  | { ok: false; error: IllegalTransition };

/** Builds the transition function of a named machine from its table. */
export function defineMachine<S extends string, E extends string>(
  machine: string,
  table: TransitionTable<S, E>,
): (from: S, event: E) => Transition<S> {
  return (from, event) => {
    const state = table[from][event];
    return state === undefined
      ? { ok: false, error: { code: "illegal-transition", machine, from, event } }
      : { ok: true, state };
  };
}
