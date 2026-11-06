/** What a host cell launches on a root, and how its root is torn down. */
export interface RootLaunch<T> {
  launch: () => Promise<T>;
  /** Work on the launched Chrome before it is handed out, such as recording its versions. */
  after: (launched: T) => Promise<void>;
  stop: (launched: T) => Promise<void>;
  removeRoot: () => Promise<void>;
}

/**
 * Launches on a root and runs `after`; on any failure stops what was launched first, so the root
 * is never removed under a running Chrome, and removes the root even when the stop fails.
 */
export async function launchOnRoot<T>({
  launch,
  after,
  stop,
  removeRoot,
}: RootLaunch<T>): Promise<T> {
  let launched: { value: T } | undefined;
  try {
    launched = { value: await launch() };
    await after(launched.value);
    return launched.value;
  } catch (error) {
    try {
      if (launched) await stop(launched.value);
    } finally {
      await removeRoot();
    }
    throw error;
  }
}
