import type { ComponentChildren } from "preact";
import { Button } from "@/ui/Button";

type Failure = { code: string; message: string };

/** What a screen loads: still loading, ready with a value, or failed with the service's error. */
export type LoadState<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; error: Failure };

export function EmptyState({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

/** The service's error message and code, with a retry when the screen can load again. */
export function ErrorState({ error, onRetry }: { error: Failure; onRetry?: () => void }) {
  return (
    <div class="error" role="alert">
      <p>
        {error.message} <code>{error.code}</code>
      </p>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

type LoadableProps<T> = {
  loaded: LoadState<T>;
  onRetry?: () => void;
  children: (value: T) => ComponentChildren;
};

export function Loadable<T>({ loaded, onRetry, children }: LoadableProps<T>) {
  if (loaded.state === "loading") return <p class="muted">Loading…</p>;
  if (loaded.state === "error") return <ErrorState error={loaded.error} onRetry={onRetry} />;
  return <>{children(loaded.value)}</>;
}
