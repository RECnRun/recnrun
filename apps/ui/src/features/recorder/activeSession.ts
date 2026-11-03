import { useState } from "preact/hooks";

const KEY = "recnrun.session";

/** The session this tab last started; storage may be unavailable, which only loses it on reload. */
function stored(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(sessionId: string | undefined) {
  try {
    if (sessionId) sessionStorage.setItem(KEY, sessionId);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage, the session is still kept while the page stays open.
  }
}

/** The recording this tab runs, kept above screen routing and across a reload of the page. */
export function useActiveSession(): [string | undefined, (sessionId: string | undefined) => void] {
  const [sessionId, setSessionId] = useState(stored);
  const set = (next: string | undefined) => {
    store(next);
    setSessionId(next);
  };
  return [sessionId, set];
}
