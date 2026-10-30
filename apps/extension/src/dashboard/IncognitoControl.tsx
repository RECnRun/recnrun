import { errorMessage } from "@recnrun/domain";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { IncognitoAccess } from "@/ports/tabs";

interface IncognitoProps {
  access: IncognitoAccess;
  onError: (caught: unknown) => void;
}

/** Leads to RECnRun's details, since only Chrome may turn on "Allow in Incognito". */
function IncognitoBanner({ access, onError }: IncognitoProps) {
  const open = () => access.openSettings().catch(onError);
  return (
    <section class="incognito-banner" aria-labelledby="incognito-heading">
      <h3 id="incognito-heading">Enable Incognito Mode</h3>
      <p>
        Allow RECnRun to access Incognito tabs so you can record and run sessions in private
        windows.
      </p>
      <p>Open the extension settings and enable “Allow in Incognito”.</p>
      <button type="button" onClick={() => void open()}>
        Open Extension Config
      </button>
    </section>
  );
}

/** Whether RECnRun may see incognito tabs; `undefined` until Chrome answers. */
type IncognitoState = IncognitoAnswer | undefined;

/** Chrome's answer, or "unknown" when it failed to give one. */
type IncognitoAnswer = boolean | "unknown";

function useIncognitoAccess(access: IncognitoAccess): IncognitoState {
  const [allowed, setAllowed] = useState<IncognitoState>();
  useEffect(() => {
    // A failed read says nothing about the toggle, so it shows neither the banner nor the button.
    void access.allowed().then(setAllowed, () => setAllowed("unknown"));
  }, [access]);
  return allowed;
}

interface ControlProps {
  access: IncognitoAccess;
  children: (allowed: IncognitoAnswer) => ComponentChildren;
}

/**
 * Leads to where to allow Incognito when RECnRun may not see it, above its children, which get
 * Chrome's answer. They wait for it, so the banner never moves a Record button.
 */
export function IncognitoControl({ access, children }: ControlProps) {
  const allowed = useIncognitoAccess(access);
  const [error, setError] = useState<string>();
  const onError = (caught: unknown) => setError(errorMessage(caught));
  if (allowed === undefined) return null;
  return (
    <>
      {allowed === false && <IncognitoBanner access={access} onError={onError} />}
      {error && <p role="alert">{error}</p>}
      {children(allowed)}
    </>
  );
}
