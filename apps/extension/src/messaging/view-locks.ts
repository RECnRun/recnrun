// Chrome keeps one Document PiP window per browser, so every extension view shares one panel.
export const PANEL_LOCK = "recnrun-panel";
// The dashboard tab owns the recording controls while it is open; framed views defer to it.
export const DASHBOARD_LOCK = "recnrun-dashboard";

// Watchers learn of a new holder here, since Web Locks only tell them when a lock frees.
function announce(name: string) {
  const channel = new BroadcastChannel(name);
  channel.postMessage("held");
  channel.close();
}

/** Holds a lock shared by the extension's views until released; Chrome frees it if the holder goes. */
export function holdLock(name: string): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  void navigator.locks.request(name, () => {
    announce(name);
    return held;
  });
  return release;
}

/** Takes the lock only if no other view holds it; resolves with its release, or undefined. */
export function claimLock(name: string): Promise<(() => void) | undefined> {
  return new Promise((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) return resolve(undefined);
      announce(name);
      return new Promise<void>((release) => resolve(release));
    });
  });
}

/** Whether any extension view, or the service worker, holds the lock. */
export async function isHeld(name: string): Promise<boolean> {
  const { held = [] } = await navigator.locks.query();
  // Watchers wait in shared mode, so only an exclusive holder counts.
  return held.some((lock) => lock.name === name && lock.mode === "exclusive");
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
