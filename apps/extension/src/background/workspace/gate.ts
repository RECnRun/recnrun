/** Marks a promise as handled now, since whoever awaits it comes later or not at all. */
export function handledLater<T>(running: Promise<T>): Promise<T> {
  running.catch(() => undefined);
  return running;
}

/** A wait one part of an operation opens once it is done, or shuts with the reason it failed. */
export interface Gate {
  promise: Promise<void>;
  open: () => void;
  shut: (error: unknown) => void;
}

export function gate(): Gate {
  const settle: Pick<Gate, "open" | "shut"> = { open: () => {}, shut: () => {} };
  const promise = new Promise<void>((open, shut) => Object.assign(settle, { open, shut }));
  return { promise: handledLater(promise), ...settle };
}
