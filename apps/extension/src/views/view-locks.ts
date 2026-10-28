// Held by the dashboard that controls the session, from taking control until its PiP window closes.
export const CONTROL_LOCK = "recnrun-control";

/** Tells every view watching the lock to check it again. */
export function announce(name: string): void {
  const channel = new BroadcastChannel(name);
  channel.postMessage("held");
  channel.close();
}

/** Whether any extension view, or the service worker, holds the lock. */
async function isHeld(name: string): Promise<boolean> {
  const { held = [] } = await navigator.locks.query();
  // Watchers wait in shared mode, so only an exclusive holder counts.
  return held.some((lock) => lock.name === name && lock.mode === "exclusive");
}

async function holdIfAvailable(name: string): Promise<(() => void) | undefined> {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const taken = await new Promise<boolean>((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      if (lock === null) return undefined;
      announce(name);
      return held;
    });
  });
  return taken ? release : undefined;
}

/**
 * Takes the lock unless any extension page holds it, atomically across them, and holds it until
 * released; Chrome frees it when the holder's page goes, as when its tab closes or reloads.
 */
export async function tryHoldLock(name: string): Promise<(() => void) | undefined> {
  for (;;) {
    const release = await holdIfAvailable(name);
    if (release || (await isHeld(name))) return release;
    // Only watchers had it, passing through in shared mode as it freed; they let go at once.
  }
}

/** Calls back with whether the lock is held, each time a view takes it and once it frees. */
export function watchLock(name: string, onChange: (held: boolean) => void): () => void {
  let watching = true;
  let waiting = false;
  const check = async () => {
    const held = await isHeld(name);
    if (!watching) return;
    onChange(held);
    if (!held || waiting) return;
    waiting = true;
    // Queues behind the holder, so this runs once the lock frees; then it checks again.
    await navigator.locks.request(name, { mode: "shared" }, () => {});
    waiting = false;
    await check();
  };
  const channel = new BroadcastChannel(name);
  channel.onmessage = () => void check();
  void check();
  return () => {
    watching = false;
    channel.close();
  };
}
