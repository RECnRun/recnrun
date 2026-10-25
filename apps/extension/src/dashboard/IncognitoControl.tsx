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
type IncognitoState = boolean | "unknown" | undefined;

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
  children: ComponentChildren;
}

/**
 * Opens an incognito window when RECnRun may see it, or leads to where to allow that, above
 * its children. They wait for Chrome's answer, so the banner never moves a Record button.
 */
export function IncognitoControl({ access, children }: ControlProps) {
  const allowed = useIncognitoAccess(access);
  const [error, setError] = useState<string>();
  const onError = (caught: unknown) => setError(errorMessage(caught));
  if (allowed === undefined) return null;
  const open = () => access.openWindow().catch(onError);
  return (
    <>
      {allowed === true && (
        <button type="button" class="tab-new-window" onClick={() => void open()}>
          New incognito window
        </button>
      )}
      {allowed === false && <IncognitoBanner access={access} onError={onError} />}
      {error && <p role="alert">{error}</p>}
      {children}
    </>
  );
}
