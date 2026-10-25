/**
 * Runs `read` at most once at a time and passes each result to `show`. A burst of `refresh` calls
 * during a read reads once more after it; a failed read shows nothing; after `stop` nothing shows
 * and no read starts.
 */
export function coalesceReads<T>(read: () => Promise<T>, show: (value: T) => void) {
  let live = true;
  let reading = false;
  let again = false;
  const refresh = (): void => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    void read()
      .then(
        (value) => {
          if (live) show(value);
        },
        () => {},
      )
      .finally(() => {
        reading = false;
        if (!again || !live) return;
        again = false;
        refresh();
      });
  };
  return {
    refresh,
    stop: (): void => {
      live = false;
    },
  };
}
