import { useEffect, useState } from "preact/hooks";
import type { IncognitoAccess } from "@/ports/tabs";
import { errorText } from "@/views/recording";

interface IncognitoProps {
  access: IncognitoAccess;
  onError: (text: string) => void;
}

/** Leads to RECnRun's details, since only Chrome may turn on "Allow in Incognito". */
function IncognitoBanner({ access, onError }: IncognitoProps) {
  const open = () => access.openSettings().catch((caught: unknown) => onError(errorText(caught)));
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

export function useIncognitoAccess(access: IncognitoAccess | undefined): IncognitoState {
  const [allowed, setAllowed] = useState<IncognitoState>();
  useEffect(() => {
    // A failed read says nothing about the toggle, so it shows neither the banner nor the button.
    void access?.allowed().then(setAllowed, () => setAllowed("unknown"));
  }, [access]);
  return access ? allowed : "unknown";
}

/** Opens an incognito window when RECnRun may see it, or leads to where to allow that. */
export function IncognitoControl({
  access,
  allowed,
  onError,
}: Omit<IncognitoProps, "access"> & { access?: IncognitoAccess; allowed: IncognitoState }) {
  if (!access || typeof allowed !== "boolean") return null;
  if (!allowed) return <IncognitoBanner access={access} onError={onError} />;
  const open = () => access.openWindow().catch((caught: unknown) => onError(errorText(caught)));
  return (
    <button type="button" class="tab-new-window" onClick={() => void open()}>
      New incognito window
    </button>
  );
}
