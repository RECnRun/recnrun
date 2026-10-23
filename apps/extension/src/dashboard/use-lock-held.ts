import { useEffect, useState } from "preact/hooks";
import { watchLock } from "@/messaging/view-locks";

/** Whether another extension view holds the lock, kept current as it changes hands. */
export function useLockHeld(name: string): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => watchLock(name, setHeld), [name]);
  return held;
}
